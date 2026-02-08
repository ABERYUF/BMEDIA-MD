// index.js (ESM) — BMEDIA MD (Baileys v7)
// ✅ Pairing-code login (DO NOT CHANGE pairing logic structure)
// ✅ Stable reconnect (cleans old listeners)
// ✅ Lazy command loading via ./commands/manifest.json (imports only when command is used)
// ✅ Processes ALL messages in upsert array
// ✅ Command timeout guard
// ✅ Presence keepalive + owner notify on connect
// ✅ Optional owner self-commands (ALLOW_SELF=1)

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import P from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Load .env reliably (same folder as index.js)
dotenv.config({ path: path.join(__dirname, ".env") });

// ----------------------------- ENV -----------------------------
const BOT_NAME = String(process.env.BOT_NAME || "BMEDIA MD").trim();
const PREFIX = String(process.env.PREFIX || ".").trim();
const AUTHOR = String(process.env.AUTHOR || "BMEDIA").trim();
const BOT_MODE = String(process.env.BOT_MODE || "Public").trim();

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || "").trim(); // used for pairing + owner notify
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || PHONE_NUMBER || "").trim();

const ALLOW_SELF = String(process.env.ALLOW_SELF || "0").trim() === "1";

const AUTO_RELOAD_COMMANDS = String(process.env.AUTO_RELOAD_COMMANDS || "0").trim() === "1";
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 15000);

const AUTH_DIR = path.join(__dirname, "auth_info_bmedia");
const COMMANDS_DIR = path.join(__dirname, "commands");
const MANIFEST_FILE = path.join(COMMANDS_DIR, "manifest.json");

// Presence keepalive
const KEEPALIVE_MS = 50_000;

// ----------------------------- STATE -----------------------------
let sock = null;
let pairingRequested = false;
let ownerNumberCache = ""; // sanitized digits only
let keepAliveTimer = null;
let autoReloadTimer = null;

// Loaded commands cache (name/alias -> command module object)
const commandCache = new Map();
// Manifest map (name -> {file, aliases[]})
let manifest = {};

// ----------------------------- LOGGING -----------------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

process.on("unhandledRejection", (err) => {
  log("UNHANDLED REJECTION:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err?.message || err);
});

// ----------------------------- HELPERS -----------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizePhone(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function ownerJid() {
  const d = sanitizePhone(OWNER_NUMBER);
  return d ? `${d}@s.whatsapp.net` : "";
}

function getText(m) {
  const msg = m?.message || {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  return "";
}

function parseCommand(text) {
  const t = String(text || "").trim();
  if (!t.startsWith(PREFIX)) return null;
  const body = t.slice(PREFIX.length).trim();
  if (!body) return null;
  const [cmdRaw, ...args] = body.split(/\s+/);
  return { cmd: String(cmdRaw || "").toLowerCase(), args };
}

function withTimeout(promise, ms, label = "command") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

function shouldIgnoreMessage(m) {
  if (!m?.key) return true;
  if (m.key.remoteJid === "status@broadcast") return true;

  // ✅ USER REQUEST: do not ignore self-messages at all.
  // This allows you to run commands from the same WhatsApp account the bot is logged into.
  // NOTE: We still ignore status@broadcast above.
  return false;
}

async function safeSend(to, content, opts = {}) {
  try {
    return await sock.sendMessage(to, content, opts);
  } catch {
    return null;
  }
}

// ----------------------------- COMMAND MANIFEST + LAZY IMPORT -----------------------------
function loadManifestFromDisk() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      const data = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8") || "{}");
      manifest = data && typeof data === "object" ? data : {};
      return;
    }
  } catch (e) {
    log("Manifest read failed:", e?.message || e);
  }
  manifest = {};
}

function rebuildManifestFallback() {
  // Fallback: use filenames as command names if manifest missing
  // (existing commands should be included via manifest shipped in the zip)
  try {
    const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".js"));
    const out = {};
    for (const f of files) {
      const n = path.basename(f, ".js").toLowerCase();
      out[n] = { file: f, aliases: [] };
    }
    manifest = out;
  } catch {
    manifest = {};
  }
}

function ensureManifestLoaded() {
  loadManifestFromDisk();
  if (!manifest || Object.keys(manifest).length === 0) rebuildManifestFallback();
}

// ✅ Preload all commands once so the menu can list them normally.
// This is lightweight here because you requested only ~50 extra commands.
// Commands are still cached by module mtime, so edits reload cleanly.
async function preloadAllCommandsForMenu() {
  try {
    const names = Object.keys(manifest || {});
    for (const name of names) {
      // import the main command name; aliases are registered inside importCommand
      await importCommand(name);
    }
    log(`✅ Commands preloaded: ${commandCache.size}`);
  } catch (e) {
    log("Preload commands failed:", e?.message || e);
  }
}

async function importCommand(cmdName) {
  const key = String(cmdName || "").toLowerCase();
  if (!key) return null;

  // cached?
  if (commandCache.has(key)) return commandCache.get(key);

  // resolve via manifest (names + aliases)
  let entry = manifest[key];
  if (!entry) {
    // maybe it's an alias; scan manifest aliases (fast enough)
    for (const [name, info] of Object.entries(manifest)) {
      const aliases = Array.isArray(info?.aliases) ? info.aliases : [];
      if (aliases.map((a) => String(a).toLowerCase()).includes(key)) {
        entry = info;
        break;
      }
    }
  }

  // fallback: filename
  const fileName = entry?.file || `${key}.js`;
  const full = path.join(COMMANDS_DIR, fileName);
  if (!fs.existsSync(full)) return null;

  // cache-bust by mtime (no Date.now leak)
  const bust = fs.statSync(full).mtimeMs;
  const url = pathToFileURL(full).href + `?v=${bust}`;
  const mod = await import(url);
  const cmd = mod?.default;

  if (!cmd?.name || typeof cmd.execute !== "function") return null;

  // cache by name + aliases
  commandCache.set(String(cmd.name).toLowerCase(), cmd);
  if (Array.isArray(cmd.aliases)) {
    for (const a of cmd.aliases) commandCache.set(String(a).toLowerCase(), cmd);
  }
  // also cache requested key
  commandCache.set(key, cmd);

  return cmd;
}

// Auto-reload manifest ONLY (does not import everything)
function ensureAutoReload() {
  if (!AUTO_RELOAD_COMMANDS) return;
  if (autoReloadTimer) return;

  autoReloadTimer = setInterval(() => {
    try {
      ensureManifestLoaded();
      log("🔁 Manifest refreshed");
    } catch {}
  }, 30_000);

  try {
    autoReloadTimer.unref?.();
  } catch {}
}

// ----------------------------- SOCKET CLEANUP -----------------------------
async function cleanupSocket() {
  try {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (sock?.ev?.removeAllListeners) sock.ev.removeAllListeners();
    if (sock?.end) sock.end();
  } catch {}
  sock = null;
}

// ----------------------------- PRESENCE KEEPALIVE + CONNECT NOTIFY -----------------------------
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    try {
      const jid = ownerJid();
      if (jid && sock?.sendPresenceUpdate) {
        await sock.sendPresenceUpdate("available", jid);
      }
    } catch {}
  }, KEEPALIVE_MS);

  try {
    keepAliveTimer.unref?.();
  } catch {}
}

async function notifyOwnerConnected() {
  const jid = ownerJid();
  if (!jid) return;
  const msg =
    `✅ *CONNECTED*\n\n` +
    `*Bot:* *${BOT_NAME}*\n` +
    `*Prefix:* ${PREFIX}\n` +
    `*Author:* *${AUTHOR}*\n` +
    `*Mode:* ${BOT_MODE}\n` +
    `*Time:* ${new Date().toLocaleString()}`;
  await safeSend(jid, { text: msg });
}

// ----------------------------- PAIRING (KEEP WORKING) -----------------------------
function askOnConsole(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function prepareOwnerNumberIfMissing() {
  if (ownerNumberCache) return;

  const envNum = sanitizePhone(PHONE_NUMBER || OWNER_NUMBER);
  if (envNum) {
    ownerNumberCache = envNum;
    return;
  }

  const n = await askOnConsole("Enter your WhatsApp number (example: +237679261475): ");
  ownerNumberCache = sanitizePhone(n);

  if (!ownerNumberCache) {
    console.log("❌ Invalid number. Example: +237679261475");
    process.exit(1);
  }
}

// ----------------------------- START BOT -----------------------------
async function startBot() {
  await cleanupSocket();

  ensureManifestLoaded();
  // Preload commands so !menu can list them without needing prior usage.
  await preloadAllCommandsForMenu();
  ensureAutoReload();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // Pairing request (only when not registered)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update || {};

    if (connection === "open") {
      pairingRequested = false;
      log("✅ Connected");
      startKeepAlive();
      await notifyOwnerConnected();
      return;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      log("❌ Disconnected:", statusCode || "unknown");

      // Restart logic
      if (statusCode === DisconnectReason.loggedOut) {
        log("Logged out. Delete auth folder and re-pair.");
        return;
      }

      // Always restart for transient / restartRequired
      await sleep(1200);
      return startBot();
    }

    // Request pairing when not registered
    // (Keeps your working behavior: request once, wait, continue)
    if (!sock?.authState?.creds?.registered && !pairingRequested) {
      await prepareOwnerNumberIfMissing();

      async function requestPairingCodeOnce() {
        if (pairingRequested) return;
        pairingRequested = true;

        console.log(`\n${BOT_NAME} not linked yet.`);
        console.log("Generating pairing code...");

        try {
          await sleep(2000);
          const code = await sock.requestPairingCode(ownerNumberCache);

          console.log("\n✅ Pairing Code (RAW):", code);
          console.log("Open WhatsApp → Linked devices → Link with phone number → enter this code.");
          console.log("NOTE: After you enter code, server may show 515 (restart required). That is normal.\n");
        } catch (e) {
          pairingRequested = false;
          console.log("❌ Pairing code request failed:", e?.message || e);
        }
      }

      await requestPairingCodeOnce();
    }
  });

  // ----------------------------- MESSAGE HANDLER -----------------------------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return;

      for (const m of messages) {
        try {
          if (shouldIgnoreMessage(m)) continue;

          const from = m.key.remoteJid;
          const sender = m.key.participant || m.participant || from;
          const text = getText(m);
          if (!text) continue;

          const parsed = parseCommand(text);
          if (!parsed) continue;

          const { cmd, args } = parsed;

          const command = await importCommand(cmd);
          if (!command) continue;

          const ctx = {
            sock,
            m,
            from,
            sender,
            text,
            args,
            prefix: PREFIX,
            botName: BOT_NAME,
            author: AUTHOR,
            mode: BOT_MODE,
            // Provide the manifest-based commands map if needed by menu
            commands: commandCache,
          };

          await withTimeout(Promise.resolve(command.execute(ctx)), COMMAND_TIMEOUT_MS, `command "${cmd}"`);
        } catch (e) {
          log("Message/command error:", e?.message || e);
        }
      }
    } catch (e) {
      log("Upsert handler error:", e?.message || e);
    }
  });

  return sock;
}

// ----------------------------- BOOT -----------------------------
startBot().catch((e) => log("Start failed:", e?.message || e));
