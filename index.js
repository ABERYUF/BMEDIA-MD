// BMEDIA-MD one-time KataBump recovery bootstrap (CommonJS)
// Upload this as /home/container/index.js ONLY when the live bot files were
// destroyed. It restores the repo non-destructively, installs dependencies,
// and hands off to the real repo entry.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const ROOT = process.cwd();

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;

    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv(path.join(ROOT, ".env"));

const REPO_URL = String(process.env.REPO_URL || "").trim();
const REPO_BRANCH = String(process.env.REPO_BRANCH || "main").trim();
const REPO_ENTRY = String(process.env.REPO_ENTRY || "index.js").trim();

if (!REPO_URL) {
  console.error("[recovery] REPO_URL is missing in /home/container/.env");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = cp.spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: opts.stdio || "inherit",
    shell: false,
    env: process.env,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `${cmd} failed with exit code ${res.status}`).trim());
  }
  return String(res.stdout || "").trim();
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function rmSafe(p) {
  try { await fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

async function copyFileAtomic(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.recovery-next-${process.pid}-${Date.now()}`;
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dst);
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
      const tempLink = `${dstPath}.recovery-next-${process.pid}-${Date.now()}`;
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

async function chooseTempParent() {
  for (const candidate of [...new Set(["/tmp", os.tmpdir()].filter(Boolean))]) {
    try {
      await fsp.mkdir(candidate, { recursive: true });
      const probe = path.join(candidate, `.bmedia-recovery-test-${process.pid}`);
      await fsp.writeFile(probe, "ok");
      await fsp.unlink(probe);
      return candidate;
    } catch {}
  }
  const fallback = path.join(ROOT, ".tmp");
  await fsp.mkdir(fallback, { recursive: true });
  return fallback;
}

function installDeps() {
  console.log("[recovery] installing/reconciling dependencies...");
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
}

function handoff() {
  const entry = path.join(ROOT, REPO_ENTRY);
  console.log(`[recovery] handing off to ${REPO_ENTRY}...`);
  const child = cp.spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error("[recovery] handoff failed:", err?.message || err);
    process.exit(1);
  });
}

(async () => {
  let tempBase = "";
  try {
    const tempParent = await chooseTempParent();
    tempBase = await fsp.mkdtemp(path.join(tempParent, "bmedia-recovery-"));
    const cloneDir = path.join(tempBase, "repo");

    console.log("[recovery] cloning repository...");
    run("git", ["clone", "--depth", "1", "--branch", REPO_BRANCH, REPO_URL, cloneDir], {
      cwd: tempBase,
      stdio: "inherit",
    });

    const clonedEntry = path.join(cloneDir, REPO_ENTRY);
    const clonedPackage = path.join(cloneDir, "package.json");

    if (!(await exists(clonedEntry))) throw new Error(`Repository is missing ${REPO_ENTRY}`);
    if (!(await exists(clonedPackage))) throw new Error("Repository is missing package.json");
    JSON.parse(await fsp.readFile(clonedPackage, "utf8"));

    console.log("[recovery] repository validated.");
    console.log("[recovery] restoring bot files WITHOUT deleting .env/auth/runtime folders...");

    // Do not overwrite the server's existing .env. Do not copy the real entry
    // until last so this recovery process remains restartable if another file
    // copy fails first.
    const entryRelNormalized = path.normalize(REPO_ENTRY);
    await copyDirAtomic(cloneDir, ROOT, {
      skip: (name, _src, _dst, rel) => {
        const normalized = path.normalize(rel);
        if (normalized === ".git" || normalized.startsWith(`.git${path.sep}`)) return true;
        if (name === ".env") return true;
        if (normalized === entryRelNormalized) return true;
        return false;
      },
    });

    await copyFileAtomic(clonedEntry, path.join(ROOT, REPO_ENTRY));

    installDeps();

    if (!(await exists(path.join(ROOT, REPO_ENTRY)))) throw new Error(`${REPO_ENTRY} is still missing after recovery`);
    if (!(await exists(path.join(ROOT, "package.json")))) throw new Error("package.json is still missing after recovery");

    await rmSafe(tempBase);
    tempBase = "";

    console.log("[recovery] bot files restored successfully.");
    handoff();
  } catch (err) {
    console.error("[recovery] failed:", err?.stack || err?.message || err);
    if (tempBase) await rmSafe(tempBase);
    process.exit(1);
  }
})();
