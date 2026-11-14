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

    if (msg?.viewOnceMessage?.message) {
      msg = msg.viewOnceMessage.message;
      continue;
    }

    if (msg?.viewOnceMessageV2?.message) {
      msg = msg.viewOnceMessageV2.message;
      continue;
    }

    if (msg?.viewOnceMessageV2Extension?.message) {
      msg = msg.viewOnceMessageV2Extension.message;
      continue;
    }

    break;
  }

  return msg;
}

function getQuotedContext(m) {
  const msg = unwrapMessage(m?.message);
  if (!msg) return null;

  for (const value of Object.values(msg)) {
    if (value?.contextInfo?.stanzaId) {
      return value.contextInfo;
    }
  }

  return (
    msg?.extendedTextMessage?.contextInfo ||
    msg?.imageMessage?.contextInfo ||
    msg?.videoMessage?.contextInfo ||
    msg?.audioMessage?.contextInfo ||
    null
  );
}

function getCachedMedia(m) {
  const context = getQuotedContext(m);

  if (!context?.stanzaId) {
    return null;
  }

  const targetKey = {
    id: context.stanzaId,
    remoteJid: m?.key?.remoteJid || context?.remoteJid,
    remoteJidAlt: m?.key?.remoteJidAlt,
    participant: context?.participant,
    participantPn: context?.participantPn,
    participantAlt: context?.participantAlt,
  };

  return findCachedViewOnce(targetKey);
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function downloadCachedMedia(cached) {
  if (!cached?.media?.media) {
    throw new Error("Cached view-once media metadata not found");
  }

  const type = cached.media.type;

  const stream = await downloadContentFromMessage(
    cached.media.media,
    type
  );

  return await streamToBuffer(stream);
}

const command = {
  name: "vv",
  aliases: ["vo", "viewonce"],
  category: "TOOLS",
  description: "Extract replied view-once media",

  async execute(ctx) {
    const { sock, m, from } = ctx;

    try {
      const cached = getCachedMedia(m);

      if (!cached?.media) {
        console.log(
          "[vv] No cached view-once metadata found for quoted message"
        );

        return await sock.sendMessage(
          from,
          {
            text:
              "❌ View-once media was not cached.\n\n" +
              "The bot must be online when the view-once message is received."
          },
          { quoted: m }
        );
      }

      console.log(`[vv] cached media found: ${cached.media.type}`);

      const buffer = await downloadCachedMedia(cached);

      if (!buffer?.length) {
        throw new Error("Downloaded media buffer is empty");
      }

      const caption = cached.media.caption || "";

      if (cached.media.type === "image") {
        return await sock.sendMessage(
          from,
          {
            image: buffer,
            caption: caption
              ? `${caption}\n\n> POWERED BY BMEDIA`
              : "> POWERED BY BMEDIA"
          },
          { quoted: m }
        );
      }

      if (cached.media.type === "video") {
        return await sock.sendMessage(
          from,
          {
            video: buffer,
            mimetype: cached.media.mimetype || "video/mp4",
            caption: caption
              ? `${caption}\n\n> POWERED BY BMEDIA`
              : "> POWERED BY BMEDIA"
          },
          { quoted: m }
        );
      }

      if (cached.media.type === "audio") {
        return await sock.sendMessage(
          from,
          {
            audio: buffer,
            mimetype: cached.media.mimetype || "audio/ogg; codecs=opus",
            ptt: Boolean(cached.media.media?.ptt)
          },
          { quoted: m }
        );
      }

      throw new Error(`Unsupported media type: ${cached.media.type}`);
    } catch (error) {
      console.error("[vv] extraction error:", error);

      return await sock.sendMessage(
        from,
        {
          text:
            `❌ Failed to extract view-once media.\n\n` +
            `${error?.message || error}`
        },
        { quoted: m }
      );
    }
  }
};

export { command };
export default command;
