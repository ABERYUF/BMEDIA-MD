// commands/vv.js
import fs from "fs/promises";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { getCachedViewOnce } from "../control/viewOnceCacheHandler.js";

function unwrap(msg) {
  if (!msg) return null;
  if (msg.ephemeralMessage?.message) return unwrap(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message) return unwrap(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message) return unwrap(msg.viewOnceMessageV2.message);
  if (msg.viewOnceMessageV2Extension?.message) return unwrap(msg.viewOnceMessageV2Extension.message);
  return msg;
}

function getContextInfo(m) {
  const root = unwrap(m?.message) || m?.message || {};
  return (
    root?.extendedTextMessage?.contextInfo ||
    root?.imageMessage?.contextInfo ||
    root?.videoMessage?.contextInfo ||
    root?.audioMessage?.contextInfo ||
    Object.values(root).find((v) => v?.contextInfo)?.contextInfo ||
    null
  );
}

function getQuotedMessage(m) {
  return getContextInfo(m)?.quotedMessage || null;
}

function getQuotedMessageId(m) {
  return String(getContextInfo(m)?.stanzaId || "").trim();
}

function detectQuotedMedia(m) {
  const quoted = getQuotedMessage(m);
  if (!quoted) return null;

  const wrapped =
    Boolean(quoted.viewOnceMessage?.message) ||
    Boolean(quoted.viewOnceMessageV2?.message) ||
    Boolean(quoted.viewOnceMessageV2Extension?.message);

  const root = unwrap(quoted);
  if (!root) return null;

  if (root.imageMessage && (wrapped || root.imageMessage.viewOnce === true)) {
    return { type: "image", media: root.imageMessage, caption: root.imageMessage.caption || "", mimetype: root.imageMessage.mimetype || "image/jpeg" };
  }

  if (root.videoMessage && (wrapped || root.videoMessage.viewOnce === true)) {
    return { type: "video", media: root.videoMessage, caption: root.videoMessage.caption || "", mimetype: root.videoMessage.mimetype || "video/mp4" };
  }

  if (root.audioMessage && (wrapped || root.audioMessage.viewOnce === true)) {
    return { type: "audio", media: root.audioMessage, caption: "", mimetype: root.audioMessage.mimetype || "audio/ogg; codecs=opus", ptt: Boolean(root.audioMessage.ptt) };
  }

  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function sendExtracted(sock, from, m, info, buffer) {
  if (!buffer?.length) throw new Error("empty media buffer");

  const caption = `> *POWERED BY BMEDIA*${info.caption ? `\n*Caption:* ${info.caption}` : ""}`;

  if (info.type === "image") {
    return sock.sendMessage(from, { image: buffer, caption, mimetype: info.mimetype || "image/jpeg" }, { quoted: m });
  }

  if (info.type === "video") {
    return sock.sendMessage(from, { video: buffer, caption, mimetype: info.mimetype || "video/mp4" }, { quoted: m });
  }

  if (info.type === "audio") {
    await sock.sendMessage(from, { text: "> *POWERED BY BMEDIA*" }, { quoted: m });
    return sock.sendMessage(from, {
      audio: buffer,
      mimetype: info.mimetype || "audio/ogg; codecs=opus",
      ptt: Boolean(info.ptt)
    }, { quoted: m });
  }

  throw new Error("unsupported media type");
}

async function handle(sock, m, from) {
  const quotedId = getQuotedMessageId(m);

  if (quotedId) {
    const cached = await getCachedViewOnce(quotedId);
    if (cached?.file) {
      try {
        const buffer = await fs.readFile(cached.file);
        return await sendExtracted(sock, from, m, cached, buffer);
      } catch (e) {
        console.log("[vv] cached media read/send failed:", e?.message || e);
      }
    }
  }

  const direct = detectQuotedMedia(m);

  if (!direct) {
    return sock.sendMessage(
      from,
      { text: "❌ Reply to a view-once image, video or voice note with .vv.\nIf the media arrived before the new cache handler was installed, it may not be recoverable." },
      { quoted: m }
    );
  }

  try {
    const stream = await downloadContentFromMessage(direct.media, direct.type);
    const buffer = await streamToBuffer(stream);
    return await sendExtracted(sock, from, m, direct, buffer);
  } catch (e) {
    console.log("[vv] direct extraction failed:", e?.message || e);
    return sock.sendMessage(
      from,
      { text: "❌ This view-once media was not cached when it arrived and WhatsApp no longer allows it to be downloaded.\nNew view-once media received after this fix should work with .vv." },
      { quoted: m }
    );
  }
}

export default {
  name: "viewonce",
  aliases: ["vo", "vv"],
  category: "TOOLS",
  description: "Extract and resend replied view-once media.",
  async execute(ctx) {
    const sock = ctx?.sock || ctx?.conn || ctx?.client;
    const m = ctx?.m;
    const from = ctx?.from || m?.key?.remoteJid;
    if (!sock || !m || !from) return;
    return handle(sock, m, from);
  },
  async run(sock, m) {
    return handle(sock, m, m?.key?.remoteJid);
  }
};
