// commands/update.js
// BMEDIA-MD safe repository updater.
// Non-destructive update strategy:
// 1) clone + validate completely before touching the live bot
// 2) never delete the live root before copying
// 3) copy files atomically over the existing installation
// 4) preserve .env/auth/runtime state
// 5) rollback repo files if applying/installing fails

import { isOwner } from "../checks/isOwner.js";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";

const ROOT = process.cwd();
const CONTROL_DIR = path.join(ROOT, "control");
const STATE_PATH = path.join(CONTROL_DIR, "repo-update.json");
const CURRENT_UPDATE_FILE = fileURLToPath(import.meta.url);
const ENV_PATH = path.join(ROOT, ".env");

const PROTECTED_ENV_KEYS = new Set([
  "SESSION_ID",
  "MASTER_SESSION_ID",
  "PHONE_NUMBER",
  "BOT_NUMBER",
  "MASTER_BOT_NUMBER",
  "OWNER_NUMBER",
  "OWNER_NUMBERS",
  "BOT_OWNER",
  "BOT_OWNERS",
  "OWNERS",
  "SUDO_NUMBER",
  "SUDO_NUMBERS",
]);

const BACKUP_SKIP_TOP_LEVEL = new Set([
  ".env",
  ".git",
  ".tmp",
  ".npm",
  ".npm-global",
  ".cache",
  "node_modules",
  "temp",
  "tmp",
  "download_temp",
  "session",
  "sessions",
  "auth_info_baileys",
  "baileys_auth_info",
  "auth_info_bmedia",
]);

function run(cmd, args, opts = {}) {
  const res = cp.spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: opts.stdio || "pipe",
    shell: false,
    env: opts.env || process.env,
    encoding: "utf8",
  });

  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `${cmd} failed`).trim());
  }

  return (res.stdout || "").trim();
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmSafe(p) {
  try {
    await fsp.rm(p, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch {}
}

async function chooseTempParent() {
  const candidates = ["/tmp", os.tmpdir()]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      await fsp.mkdir(candidate, { recursive: true });
      const probe = path.join(candidate, `.bmedia-write-test-${process.pid}-${Date.now()}`);
      await fsp.writeFile(probe, "ok");
      await fsp.unlink(probe);
      return candidate;
    } catch {}
  }

  // Last resort. The updater is non-destructive, so using a temp folder under
  // the live root is still safe; it will never delete ROOT/.tmp anymore.
  const fallback = path.join(ROOT, ".tmp");
  await fsp.mkdir(fallback, { recursive: true });
  return fallback;
}

function parseEnvAssignments(content = "") {
  const map = new Map();
  const lines = String(content || "").split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    map.set(match[1], {
      rawValue: match[2],
      parsedValue: parseEnvValue(match[2]),
    });
  }

  return map;
}

function parseEnvValue(raw = "") {
  let value = String(raw ?? "").trim();
  if (!value) return "";

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return value;
  }

  const commentIndex = value.search(/\s+#/);
  if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  return value;
}

function mergeEnvDocuments(currentContent, repositoryContent) {
  if (!String(repositoryContent || "").trim()) {
    return String(currentContent || "");
  }

  const currentMap = parseEnvAssignments(currentContent);
  const repositoryLines = String(repositoryContent).split(/\r?\n/);
  const repositoryKeys = new Set();

  const mergedLines = repositoryLines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;

    const [, prefix, key, separator] = match;
    repositoryKeys.add(key);

    if (!PROTECTED_ENV_KEYS.has(key) || !currentMap.has(key)) return line;
    return `${prefix}${key}${separator}${currentMap.get(key).rawValue}`;
  });

  const missingProtected = [];
  for (const key of PROTECTED_ENV_KEYS) {
    if (!repositoryKeys.has(key) && currentMap.has(key)) {
      missingProtected.push(`${key}=${currentMap.get(key).rawValue}`);
    }
  }

  let output = mergedLines.join("\n").replace(/\s+$/g, "");
  if (missingProtected.length) {
    output += `\n\n# Preserved user identity values\n${missingProtected.join("\n")}`;
  }

  return `${output}\n`;
}

function buildRestartEnv(oldEnvContent, mergedEnvContent) {
  const oldMap = parseEnvAssignments(oldEnvContent);
  const nextMap = parseEnvAssignments(mergedEnvContent);
  const env = { ...process.env };
  const externallyOverridden = new Set();

  for (const [key, oldEntry] of oldMap) {
    if (Object.prototype.hasOwnProperty.call(env, key) && String(env[key]) !== oldEntry.parsedValue) {
      externallyOverridden.add(key);
    }
  }

  for (const key of oldMap.keys()) {
    if (!externallyOverridden.has(key)) delete env[key];
  }

  for (const [key, entry] of nextMap) {
    if (!externallyOverridden.has(key)) env[key] = entry.parsedValue;
  }

  return env;
}

async function writeFileAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.bmedia-next-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, content, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function copyFileAtomic(srcPath, dstPath) {
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  const tempPath = `${dstPath}.bmedia-next-${process.pid}-${Date.now()}`;
  await fsp.copyFile(srcPath, tempPath);
  await fsp.rename(tempPath, dstPath);
}

async function copyDirAtomic(src, dst, opts = {}, rel = "") {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await fsp.mkdir(dst, { recursive: true });

  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (opts.skip && opts.skip(entry.name, srcPath, dstPath, childRel)) continue;

    if (entry.isDirectory()) {
      await copyDirAtomic(srcPath, dstPath, opts, childRel);
    } else if (entry.isSymbolicLink()) {
      const target = await fsp.readlink(srcPath);
      const tempLink = `${dstPath}.bmedia-next-${process.pid}-${Date.now()}`;
      await rmSafe(tempLink);
      await fsp.mkdir(path.dirname(dstPath), { recursive: true });
      await fsp.symlink(target, tempLink);
      await rmSafe(dstPath);
      await fsp.rename(tempLink, dstPath);
    } else {
      await copyFileAtomic(srcPath, dstPath);
    }
  }
}

async function backupLiveRepo(backupDir) {
  await fsp.mkdir(backupDir, { recursive: true });
  const entries = await fsp.readdir(ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (BACKUP_SKIP_TOP_LEVEL.has(entry.name)) continue;
    const src = path.join(ROOT, entry.name);
    const dst = path.join(backupDir, entry.name);

    try {
      if (entry.isDirectory()) {
        await fsp.cp(src, dst, { recursive: true, force: true });
      } else if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(src);
        await fsp.symlink(target, dst).catch(() => {});
      } else {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
      }
    } catch (e) {
      throw new Error(`Backup failed for ${entry.name}: ${e?.message || e}`);
    }
  }
}

async function restoreLiveRepo(backupDir, oldEnvContent) {
  if (await pathExists(backupDir)) {
    await copyDirAtomic(backupDir, ROOT);
  }
  await writeFileAtomic(ENV_PATH, oldEnvContent || "");
}

async function readState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    return {
      currentCommit: String(j?.currentCommit || "").trim(),
      branch: String(j?.branch || "").trim(),
      repo: String(j?.repo || "").trim(),
      updatedAt: String(j?.updatedAt || "").trim(),
    };
  } catch {
    return { currentCommit: "", branch: "", repo: "", updatedAt: "" };
  }
}

async function writeState(state) {
  await fsp.mkdir(CONTROL_DIR, { recursive: true });
  await fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function validateClone(cloneDir, repoEntry) {
  if (!(await pathExists(cloneDir))) {
    throw new Error("Repository clone directory disappeared before update could begin.");
  }

  const entryPath = path.join(cloneDir, repoEntry);
  if (!(await pathExists(entryPath))) {
    throw new Error(`Repository validation failed: ${repoEntry} is missing.`);
  }

  const packagePath = path.join(cloneDir, "package.json");
  if (!(await pathExists(packagePath))) {
    throw new Error("Repository validation failed: package.json is missing.");
  }

  try {
    JSON.parse(await fsp.readFile(packagePath, "utf8"));
  } catch (e) {
    throw new Error(`Repository validation failed: package.json is invalid (${e?.message || e}).`);
  }
}

async function installDeps() {
  if (!(await pathExists(path.join(ROOT, "package.json")))) {
    throw new Error("package.json disappeared before dependency installation.");
  }

  if (await pathExists(path.join(ROOT, "pnpm-lock.yaml"))) {
    run("pnpm", ["install", "--frozen-lockfile", "--prod"], { stdio: "inherit" });
    return;
  }

  if (await pathExists(path.join(ROOT, "yarn.lock"))) {
    run("yarn", ["install", "--frozen-lockfile", "--production=true"], { stdio: "inherit" });
    return;
  }

  // Deliberately use npm install instead of npm ci here. npm ci removes the
  // existing node_modules tree first; on a failed update that can leave a
  // previously working Pterodactyl/KataBump bot unable to boot.
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { stdio: "inherit" });
}

async function preserveManagedUpdater(cloneDir) {
  const source = await fsp.readFile(CURRENT_UPDATE_FILE, "utf8");
  const target = path.join(cloneDir, "commands", "update.js");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, source, "utf8");
}

async function restartBot(entry, restartEnv) {
  const entryAbs = path.join(ROOT, entry);
  if (!(await pathExists(entryAbs))) {
    throw new Error(`Restart blocked: ${entry} is missing after update.`);
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  if (typeof process.execve === "function") {
    process.execve(process.execPath, [process.execPath, entryAbs], restartEnv);
    return;
  }

  const child = cp.spawn(process.execPath, [entryAbs], {
    cwd: ROOT,
    stdio: "inherit",
    env: restartEnv,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[update] restart fallback failed:", error?.message || error);
    process.exit(1);
  });
}

export default {
  name: "update",
  aliases: ["upgrade", "pullupdate"],
  category: "OWNER",
  description: "Check repository updates and safely update the bot.",
  usage: "update",

  async execute(ctx) {
    const { sock, m, from } = ctx;

    if (!isOwner(m, sock)) {
      return sock.sendMessage(from, { text: "❌ Owner only." }, { quoted: m });
    }

    const REPO_URL = String(process.env.REPO_URL || "").trim();
    const REPO_BRANCH = String(process.env.REPO_BRANCH || "main").trim();
    const REPO_ENTRY = String(process.env.REPO_ENTRY || "index.js").trim();

    if (!REPO_URL) {
      return sock.sendMessage(from, { text: "❌ REPO_URL is missing in .env" }, { quoted: m });
    }

    let tempBase = "";
    let backupDir = "";
    let oldEnvContent = "";
    let updateStarted = false;

    try {
      await sock.sendMessage(from, { text: "🔍 Checking for updates..." }, { quoted: m });

      const tempParent = await chooseTempParent();
      tempBase = await fsp.mkdtemp(path.join(tempParent, "bmedia-update-"));
      const cloneDir = path.join(tempBase, "repo");
      backupDir = path.join(tempBase, "rollback");

      run("git", ["clone", "--branch", REPO_BRANCH, REPO_URL, cloneDir], {
        cwd: tempBase,
        stdio: "inherit",
      });

      await validateClone(cloneDir, REPO_ENTRY);

      const remoteHead = run("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
      const state = await readState();
      let updates = 0;
      let firstSync = false;

      if (state.currentCommit) {
        try {
          updates = parseInt(
            run("git", ["rev-list", "--count", `${state.currentCommit}..HEAD`], { cwd: cloneDir }),
            10
          );
          if (!Number.isFinite(updates)) updates = 0;
        } catch {
          updates = remoteHead !== state.currentCommit ? 1 : 0;
        }
      } else {
        firstSync = true;
      }

      if (!firstSync && updates <= 0) {
        await rmSafe(tempBase);
        return sock.sendMessage(from, { text: "✅ Bot is already up to date." }, { quoted: m });
      }

      await sock.sendMessage(
        from,
        {
          text: firstSync
            ? "♻️ First update sync detected. Preparing safe update..."
            : `♻️ ${updates} update(s) found. Preparing safe update...`,
        },
        { quoted: m }
      );

      oldEnvContent = (await pathExists(ENV_PATH)) ? await fsp.readFile(ENV_PATH, "utf8") : "";
      const clonedEnvPath = path.join(cloneDir, ".env");
      const repoEnvContent = (await pathExists(clonedEnvPath))
        ? await fsp.readFile(clonedEnvPath, "utf8")
        : "";
      const mergedEnvContent = mergeEnvDocuments(oldEnvContent, repoEnvContent);
      const restartEnv = buildRestartEnv(oldEnvContent, mergedEnvContent);

      // Ensure this fixed updater survives even if the repository still contains
      // an older destructive version.
      await preserveManagedUpdater(cloneDir);

      // Snapshot the currently working application BEFORE replacing anything.
      await backupLiveRepo(backupDir);
      updateStarted = true;

      // Non-destructive overlay: do NOT clean /home/container. Each file is
      // replaced atomically, so index.js/package.json are never intentionally
      // removed during an update.
      await copyDirAtomic(cloneDir, ROOT, {
        skip: (name, _src, _dst, rel) => rel === ".git" || rel.startsWith(`.git${path.sep}`) || name === ".env",
      });

      if (mergedEnvContent || oldEnvContent) {
        await writeFileAtomic(ENV_PATH, mergedEnvContent || oldEnvContent);
      }

      await installDeps();

      // Final safety check before recording success/restarting.
      if (!(await pathExists(path.join(ROOT, REPO_ENTRY)))) {
        throw new Error(`Safety check failed: ${REPO_ENTRY} is missing after update.`);
      }
      if (!(await pathExists(path.join(ROOT, "package.json")))) {
        throw new Error("Safety check failed: package.json is missing after update.");
      }

      await writeState({
        currentCommit: remoteHead,
        branch: REPO_BRANCH,
        repo: REPO_URL,
        updatedAt: new Date().toISOString(),
      });

      await sock.sendMessage(
        from,
        {
          text: firstSync
            ? "✅ Bot synced safely. Restarting now..."
            : `✅ Updated safely with ${updates} update(s). Restarting now...`,
        },
        { quoted: m }
      );

      // Remove staging only after the live installation is complete.
      await rmSafe(tempBase);
      tempBase = "";

      await restartBot(REPO_ENTRY, restartEnv);
    } catch (e) {
      const errorText = e?.message || String(e);

      if (updateStarted && backupDir && (await pathExists(backupDir))) {
        try {
          await restoreLiveRepo(backupDir, oldEnvContent);
          await sock.sendMessage(
            from,
            { text: `❌ Update failed, but the previous bot files were restored.\n${errorText}` },
            { quoted: m }
          );
        } catch (rollbackError) {
          await sock.sendMessage(
            from,
            {
              text:
                `❌ Update failed and automatic rollback also failed.\n` +
                `Update error: ${errorText}\n` +
                `Rollback error: ${rollbackError?.message || rollbackError}`,
            },
            { quoted: m }
          );
        }
      } else {
        await sock.sendMessage(
          from,
          { text: `❌ Update failed before live files were changed.\n${errorText}` },
          { quoted: m }
        );
      }

      if (tempBase) await rmSafe(tempBase);
      return;
    }
  },
};
