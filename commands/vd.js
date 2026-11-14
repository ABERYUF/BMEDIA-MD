// commands/vd.js (ESM)
//
// Owner-only: extract a replied view-once media message and send it
// to a destination number/JID. If no destination is supplied,
// OWNER_NUMBER from .env is used.
//
// Usage:
//   .vd
//   .vd 237679261475
//   .vd 237679261475@s.whatsapp.net

import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { isOwner } from "../checks/isOwner.js";
import { findCachedViewOnce } from "../control/viewOnceAlienReactionHandler.js";

function getSender(m) {
  return (
    m?.key?.participant ||
    m?.participant ||
    m?.sender ||
    m?.key?.remoteJid ||
    ""
  );
}

const tagOf = (jid) =>
  `@${String(jid || "").split("@")[0].split(":")[0]}`;

function toUserJid(input) {
  const n = String(input || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "");

  if (!n) return null;

  return `${n}@s.whatsapp.net`;
}

function normalizeDest(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  return toUserJid(raw);
}

function getOwnerDmJidFromEnv() {
  return toUserJid(process.env.OWNER_NUMBER || "");
}

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
    msg?.documentMessage?.contextInfo ||
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

    remoteJid:
      m?.key?.remoteJid ||
      context?.remoteJid,

    remoteJidAlt:
      m?.key?.remoteJidAlt,

    participant:
      context?.participant,

    participantPn:
      context?.participantPn,

    participantAlt:
      context?.participantAlt,
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

  const stream = await downloadContentFromMessage(
    cached.media.media,
    cached.media.type
  );

  return streamToBuffer(stream);
}

const command = {
  name: "vd",

  aliases: [
    "vdowner",
    "v2dm"
  ],

  category: "OWNER",

  description:
    "Owner-only: Extract replied view-once media and send it to a destination JID or OWNER_NUMBER.",

  async execute(ctx) {
    const {
      sock,
      m,
      from,
      args = []
    } = ctx;

    const sender = getSender(m) || from;

    // OWNER ONLY
    if (!isOwner(m, sock)) {
      const tag = tagOf(sender);

      return sock.sendMessage(
        from,
        {
          text: `❌ Owner only.\n\n${tag}`,
          mentions: sender ? [sender] : []
        },
        {
          quoted: m
        }
      );
    }

    // Destination:
    // .vd <number/JID>
    // or OWNER_NUMBER from .env
    const dest =
      normalizeDest(args[0]) ||
      getOwnerDmJidFromEnv();

    if (!dest) {
      return sock.sendMessage(
        from,
        {
          text:
            "❌ OWNER_NUMBER is missing/invalid in .env.\n" +
            "Set: OWNER_NUMBER=237xxxxxxxxx"
        },
        {
          quoted: m
        }
      );
    }

    try {
      const cached = getCachedMedia(m);

      if (!cached?.media) {
        console.log(
          "[vd] No cached view-once metadata found for quoted message"
        );

        return sock.sendMessage(
          from,
          {
            text:
              "❌ View-once media was not cached.\n\n" +
              "The bot must be online when the view-once message is received."
          },
          {
            quoted: m
          }
        );
      }

      console.log(
        `[vd] cached media found: ${cached.media.type}`
      );

      const buffer = await downloadCachedMedia(cached);

      if (!buffer?.length) {
        throw new Error(
          "Downloaded media buffer is empty"
        );
      }

      // Silent delivery to destination.
      if (cached.media.type === "image") {
        await sock.sendMessage(
          dest,
          {
            image: buffer,
            mimetype:
              cached.media.mimetype ||
              "image/jpeg"
          }
        );

        return;
      }

      if (cached.media.type === "video") {
        await sock.sendMessage(
          dest,
          {
            video: buffer,
            mimetype:
              cached.media.mimetype ||
              "video/mp4"
          }
        );

        return;
      }

      if (cached.media.type === "audio") {
        await sock.sendMessage(
          dest,
          {
            audio: buffer,

            mimetype:
              cached.media.mimetype ||
              "audio/ogg; codecs=opus",

            ptt: Boolean(
              cached.media.media?.ptt
            )
          }
        );

        return;
      }

      throw new Error(
        `Unsupported media type: ${cached.media.type}`
      );

    } catch (error) {
      console.error(
        "[vd] error:",
        error
      );

      return sock.sendMessage(
        from,
        {
          text:
            `❌ vd error: ` +
            `${error?.message || error}`
        },
        {
          quoted: m
        }
      );
    }
  }
};

export { command };
export default command;
