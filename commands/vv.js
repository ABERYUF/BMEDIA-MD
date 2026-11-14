// commands/vv.js

import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { findCachedViewOnce } from "../control/viewOnceAlienReactionHandler.js";


function unwrapMessage(message = {}) {
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

function getQuotedContext(m) {
  const msg = unwrapMessage(m?.message);
  if (!msg) return null;

  const direct =
    msg?.extendedTextMessage?.contextInfo ||
    msg?.imageMessage?.contextInfo ||
    msg?.videoMessage?.contextInfo ||
    msg?.audioMessage?.contextInfo ||
    msg?.documentMessage?.contextInfo;

  if (direct) return direct;

  for (const value of Object.values(msg)) {
    if (value?.contextInfo) return value.contextInfo;
  }

  return null;
}

function isViewOnceQuoted(m) {
  const context = getQuotedContext(m);
  const quoted = context?.quotedMessage;

  if (!quoted) return false;

  const q = unwrapMessage(quoted);

  if (
    q?.viewOnceMessage?.message ||
    q?.viewOnceMessageV2?.message ||
    q?.viewOnceMessageV2Extension?.message
  ) {
    return true;
  }

  if (
    q?.imageMessage?.viewOnce ||
    q?.videoMessage?.viewOnce ||
    q?.audioMessage?.viewOnce
  ) {
    return true;
  }

  return false;
}

function getCachedMedia(m) {
  const context = getQuotedContext(m);

  if (!context?.stanzaId) {
    return null;
  }

  return findCachedViewOnce({
    id: context.stanzaId,
    remoteJid: m?.key?.remoteJid || context?.remoteJid,
    remoteJidAlt: m?.key?.remoteJidAlt,
    participant: context?.participant,
    participantPn: context?.participantPn,
    participantAlt: context?.participantAlt,
  });
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function downloadCachedMedia(cached) {
  if (!cached?.media?.media || !cached?.media?.type) {
    return null;
  }

  const stream = await downloadContentFromMessage(
    cached.media.media,
    cached.media.type
  );

  return streamToBuffer(stream);
}


const command = {
  name: "vv",
  aliases: ["vo", "viewonce"],
  category: "TOOLS",
  description: "Extract replied view-once media",

  async execute(ctx) {
    const { sock, m, from } = ctx;

    // 1. Command was not used on a view-once message.
    if (!isViewOnceQuoted(m)) {
      return sock.sendMessage(
        from,
        { text: "❌ Reply to a view once" },
        { quoted: m }
      );
    }

    // 2. It is view-once, but we do not have usable cached media.
    const cached = getCachedMedia(m);

    if (!cached?.media?.media || !cached?.media?.type) {
      return sock.sendMessage(
        from,
        { text: "❌ No media" },
        { quoted: m }
      );
    }

    try {
      const buffer = await downloadCachedMedia(cached);

      if (!buffer?.length) {
        return sock.sendMessage(
          from,
          { text: "❌ No media" },
          { quoted: m }
        );
      }

      const caption = cached.media.caption || "";

      if (cached.media.type === "image") {
        return sock.sendMessage(
          from,
          {
            image: buffer,
            caption: caption
              ? `${caption}\n\n> POWERED BY BMEDIA`
              : "> POWERED BY BMEDIA",
          },
          { quoted: m }
        );
      }

      if (cached.media.type === "video") {
        return sock.sendMessage(
          from,
          {
            video: buffer,
            mimetype: cached.media.mimetype || "video/mp4",
            caption: caption
              ? `${caption}\n\n> POWERED BY BMEDIA`
              : "> POWERED BY BMEDIA",
          },
          { quoted: m }
        );
      }

      if (cached.media.type === "audio") {
        return sock.sendMessage(
          from,
          {
            audio: buffer,
            mimetype: cached.media.mimetype || "audio/ogg; codecs=opus",
            ptt: Boolean(cached.media.media?.ptt),
          },
          { quoted: m }
        );
      }

      return sock.sendMessage(
        from,
        { text: "❌ No media" },
        { quoted: m }
      );
    } catch (error) {
      console.error("[vv] error:", error);

      return sock.sendMessage(
        from,
        { text: "❌ Could not get media, report to HQ" },
        { quoted: m }
      );
    }
  },
};

export { command };
export default command;
