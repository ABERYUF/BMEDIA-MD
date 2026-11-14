// control/viewOnceAlienReactionHandler.js
// Automatically extracts view-once image/video when owner/sudo/self reacts with 👻.
// No command required.
//
// Important:
// - Caches ONLY view-once metadata required by Baileys to download later.
// - Does NOT store downloaded media buffers.
// - Does NOT write media files to disk.
// - Cache entries expire after 24 hours.

import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { isOwner } from "../checks/isOwner.js";
import { isSudoByJid } from "../checks/isSudo.js";

const TRIGGER_EMOJI = "👻";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 3000;

const viewOnceCache = new Map();
let cleanupStarted = false;

function cleanNumber(value = "") {
  return String(value || "").replace(/[^\d]/g, "");
}

function toPhoneJid(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (raw.endsWith("@s.whatsapp.net")) {
    const num = cleanNumber(raw.split("@")[0].split(":")[0]);
    return num ? `${num}@s.whatsapp.net` : "";
  }

  if (raw.includes("@lid")) return "";

  const num = cleanNumber(raw);
  return num ? `${num}@s.whatsapp.net` : "";
}

function getOwnerDmJid(senderJid = "") {
  return (
    toPhoneJid(process.env.OWNER_NUMBER) ||
    toPhoneJid(process.env.BOT_OWNER) ||
    toPhoneJid(process.env.PHONE_NUMBER) ||
    toPhoneJid(senderJid)
  );
}

function normalizeJid(value = "") {
  return String(value || "").trim().toLowerCase();
}

function getMessageId(key = {}) {
  return String(key?.id || "").trim();
}

function isAllowedReactor(m, senderJid = "") {
  if (m?.key?.fromMe) return true;

  try {
    if (isOwner({ senderJid })) return true;
  } catch {}

  try {
    if (isSudoByJid(senderJid)) return true;
  } catch {}

  return false;
}

function unwrapEphemeral(message = {}) {
  let msg = message || {};

  for (let i = 0; i < 10; i++) {
    if (msg?.ephemeralMessage?.message) {
      msg = msg.ephemeralMessage.message;
      continue;
    }
    break;
  }

  return msg;
}

function getViewOnceInnerMessage(message = {}) {
  const msg = unwrapEphemeral(message);

  if (msg?.viewOnceMessage?.message) {
    return msg.viewOnceMessage.message;
  }

  if (msg?.viewOnceMessageV2?.message) {
    return msg.viewOnceMessageV2.message;
  }

  if (msg?.viewOnceMessageV2Extension?.message) {
    return msg.viewOnceMessageV2Extension.message;
  }

  if (msg?.imageMessage?.viewOnce || msg?.videoMessage?.viewOnce) {
    return msg;
  }

  return null;
}

function stripHeavyFields(media = {}) {
  if (!media || typeof media !== "object") return media;

  const clone = { ...media };

  delete clone.jpegThumbnail;
  delete clone.thumbnail;
  delete clone.thumbnailDirectPath;
  delete clone.thumbnailSha256;
  delete clone.thumbnailEncSha256;
  delete clone.scansSidecar;
  delete clone.firstScanSidecar;
  delete clone.midQualityFileSha256;
  delete clone.contextInfo;

  return clone;
}

function extractViewOnceMedia(message = {}) {
  const inner = getViewOnceInnerMessage(message);
  if (!inner) return null;

  if (inner?.imageMessage) {
    return {
      type: "image",
      media: stripHeavyFields(inner.imageMessage),
      caption: inner.imageMessage.caption || "",
      mimetype: inner.imageMessage.mimetype || "image/jpeg",
    };
  }

  if (inner?.videoMessage) {
    return {
      type: "video",
      media: stripHeavyFields(inner.videoMessage),
      caption: inner.videoMessage.caption || "",
      mimetype: inner.videoMessage.mimetype || "video/mp4",
    };
  }

  return null;
}

function makeKeysFromMessage(m = {}) {
  const id = getMessageId(m?.key);
  if (!id) return [];

  const keys = new Set();

  const remoteJids = [
    m?.key?.remoteJid,
    m?.key?.remoteJidAlt,
    m?.remoteJid,
    m?.remoteJidAlt,
  ]
    .map(normalizeJid)
    .filter(Boolean);

  const participants = [
    m?.key?.participant,
    m?.key?.participantPn,
    m?.key?.participantAlt,
    m?.participant,
    m?.participantPn,
    m?.participantAlt,
  ]
    .map(normalizeJid)
    .filter(Boolean);

  for (const jid of remoteJids) {
    keys.add(`${jid}::${id}`);
  }

  for (const jid of remoteJids) {
    for (const p of participants) {
      keys.add(`${jid}::${p}::${id}`);
    }
  }

  keys.add(`id::${id}`);

  return [...keys];
}

function makeKeysFromReactionKey(key = {}) {
  const id = getMessageId(key);
  if (!id) return [];

  const keys = new Set();

  const remoteJids = [key?.remoteJid, key?.remoteJidAlt]
    .map(normalizeJid)
    .filter(Boolean);

  const participants = [
    key?.participant,
    key?.participantPn,
    key?.participantAlt,
  ]
    .map(normalizeJid)
    .filter(Boolean);

  for (const jid of remoteJids) {
    keys.add(`${jid}::${id}`);
  }

  for (const jid of remoteJids) {
    for (const p of participants) {
      keys.add(`${jid}::${p}::${id}`);
    }
  }

  keys.add(`id::${id}`);

  return [...keys];
}

function cleanupExpiredCache() {
  const cutoff = Date.now() - CACHE_TTL_MS;

  for (const [key, value] of viewOnceCache.entries()) {
    if (!value?.cachedAt || value.cachedAt < cutoff) {
      viewOnceCache.delete(key);
    }
  }

  if (viewOnceCache.size > MAX_CACHE_ENTRIES) {
    const sorted = [...viewOnceCache.entries()].sort(
      (a, b) => Number(a[1]?.cachedAt || 0) - Number(b[1]?.cachedAt || 0)
    );

    const removeCount = viewOnceCache.size - MAX_CACHE_ENTRIES;
    for (let i = 0; i < removeCount; i++) {
      viewOnceCache.delete(sorted[i][0]);
    }
  }
}

function startCleanupTimer() {
  if (cleanupStarted) return;
  cleanupStarted = true;

  const timer = setInterval(cleanupExpiredCache, CLEANUP_INTERVAL_MS);
  try {
    timer.unref?.();
  } catch {}
}

function cacheViewOnceMessage(m = {}) {
  startCleanupTimer();
  cleanupExpiredCache();

  if (!m?.key?.id || !m?.message) return false;
  if (m.message.reactionMessage) return false;

  const media = extractViewOnceMedia(m.message);
  if (!media) return false;

  const keys = makeKeysFromMessage(m);
  if (!keys.length) return false;

  const record = {
    cachedAt: Date.now(),
    expiresAt: Date.now() + CACHE_TTL_MS,
    key: m.key,
    sourceChat: m?.key?.remoteJid || "",
    sourceChatAlt: m?.key?.remoteJidAlt || "",
    media,
  };

  for (const key of keys) {
    viewOnceCache.set(key, record);
  }

  return true;
}

export function findCachedViewOnce(reactionKey = {}) {
  cleanupExpiredCache();

  const keys = makeKeysFromReactionKey(reactionKey);

  for (const key of keys) {
    const found = viewOnceCache.get(key);
    if (found?.media) return found;
  }

  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadMediaBuffer(type, mediaMessage) {
  const stream = await downloadContentFromMessage(mediaMessage, type);
  return streamToBuffer(stream);
}

async function sendToOwnerDm(sock, ownerJid, cached, buffer) {
  const media = cached.media;

  const caption = [
    media.caption || "",
    "",
    "╭─〔 *VIEW ONCE* 〕",
    `├◦ Type : ${media.type}`,
    cached.sourceChat ? `├◦ Chat : ${cached.sourceChat}` : "",
    "╰◦ Extracted by 👻 reaction",
    "",
    "> POWERED BY BMEDIA",
  ]
    .filter(Boolean)
    .join("\n");

  if (media.type === "image") {
    return sock.sendMessage(ownerJid, {
      image: buffer,
      caption,
      mimetype: media.mimetype,
    });
  }

  if (media.type === "video") {
    return sock.sendMessage(ownerJid, {
      video: buffer,
      caption,
      mimetype: media.mimetype,
    });
  }
}

export async function handleViewOnceAlienReaction(sock, m, from, senderJid) {
  cacheViewOnceMessage(m);

  const reaction = m?.message?.reactionMessage;
  if (!reaction) return false;

  const emoji = String(reaction?.text || "").trim();
  if (emoji !== TRIGGER_EMOJI) return false;

  if (!isAllowedReactor(m, senderJid)) {
    return true;
  }

  const targetKey = reaction.key;
  if (!targetKey?.id) return true;

  const cached = findCachedViewOnce(targetKey);

  if (!cached?.media) return true;

  const ownerDm = getOwnerDmJid(senderJid);
  if (!ownerDm) return true;

  try {
    const buffer = await downloadMediaBuffer(cached.media.type, cached.media.media);
    if (!buffer || !buffer.length) return true;

    await sendToOwnerDm(sock, ownerDm, cached, buffer);
    return true;
  } catch {
    return true;
  }
}

export function getViewOnceAlienCacheStats() {
  cleanupExpiredCache();

  const ids = new Set();

  for (const value of viewOnceCache.values()) {
    const id = getMessageId(value?.key);
    if (id) ids.add(id);
  }

  return {
    keys: viewOnceCache.size,
    uniqueViewOnceMessages: ids.size,
    ttlHours: 24,
    maxEntries: MAX_CACHE_ENTRIES,
  };
}
