// control/viewOnceCacheHandler.js
import fs from "fs/promises";
import path from "path";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "control", "viewonce-cache");
const INDEX_FILE = path.join(CACHE_DIR, "index.json");
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 120;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function unwrap(msg) {
  if (!msg) return null;
  if (msg.ephemeralMessage?.message) return unwrap(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message) return unwrap(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message) return unwrap(msg.viewOnceMessageV2.message);
  if (msg.viewOnceMessageV2Extension?.message) return unwrap(msg.viewOnceMessageV2Extension.message);
  return msg;
}

function detectViewOnce(message) {
  if (!message) return null;
  const wrapped =
    Boolean(message.viewOnceMessage?.message) ||
    Boolean(message.viewOnceMessageV2?.message) ||
    Boolean(message.viewOnceMessageV2Extension?.message);

  const root = unwrap(message);
  if (!root) return null;

  const image = root.imageMessage;
  if (image && (wrapped || image.viewOnce === true)) {
    return { type: "image", media: image, mimetype: image.mimetype || "image/jpeg", caption: image.caption || "", ext: "jpg" };
  }

  const video = root.videoMessage;
  if (video && (wrapped || video.viewOnce === true)) {
    return { type: "video", media: video, mimetype: video.mimetype || "video/mp4", caption: video.caption || "", ext: "mp4" };
  }

  const audio = root.audioMessage;
  if (audio && (wrapped || audio.viewOnce === true)) {
    const mime = audio.mimetype || "audio/ogg; codecs=opus";
    return { type: "audio", media: audio, mimetype: mime, caption: "", ptt: Boolean(audio.ptt), ext: mime.includes("mpeg") ? "mp3" : "ogg" };
  }

  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readIndex() {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function writeIndex(index) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
  await fs.rename(tmp, INDEX_FILE);
}

function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

async function removeRecord(index, id) {
  const rec = index[id];
  if (!rec) return;
  if (rec.file) await fs.rm(rec.file, { force: true }).catch(() => {});
  delete index[id];
}

async function cleanup(index) {
  const now = Date.now();

  for (const [id, rec] of Object.entries(index)) {
    if (!rec?.createdAt || now - Number(rec.createdAt) > TTL_MS || !(await exists(rec.file || ""))) {
      await removeRecord(index, id);
    }
  }

  const entries = Object.entries(index).sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0));
  while (entries.length > MAX_ENTRIES) {
    const [id] = entries.shift();
    await removeRecord(index, id);
  }

  return index;
}

export async function cacheIncomingViewOnce(m) {
  try {
    const id = String(m?.key?.id || "").trim();
    if (!id || !m?.message) return false;

    const info = detectViewOnce(m.message);
    if (!info) return false;

    await fs.mkdir(CACHE_DIR, { recursive: true });
    let index = await readIndex();
    index = await cleanup(index);

    if (index[id]?.file && (await exists(index[id].file))) return true;

    const stream = await downloadContentFromMessage(info.media, info.type);
    const buffer = await streamToBuffer(stream);
    if (!buffer?.length) return false;

    const file = path.join(CACHE_DIR, `${safeId(id)}.${info.ext}`);
    await fs.writeFile(file, buffer);

    index[id] = {
      id,
      file,
      type: info.type,
      mimetype: info.mimetype,
      caption: info.caption || "",
      ptt: Boolean(info.ptt),
      createdAt: Date.now(),
      chat: m?.key?.remoteJid || "",
      participant: m?.key?.participant || ""
    };

    await writeIndex(index);
    return true;
  } catch (e) {
    console.log("[viewonce-cache] cache failed:", e?.message || e);
    return false;
  }
}

export async function getCachedViewOnce(messageId) {
  try {
    const id = String(messageId || "").trim();
    if (!id) return null;

    let index = await readIndex();
    index = await cleanup(index);
    await writeIndex(index);

    const rec = index[id];
    if (!rec?.file || !(await exists(rec.file))) return null;
    return rec;
  } catch {
    return null;
  }
}
