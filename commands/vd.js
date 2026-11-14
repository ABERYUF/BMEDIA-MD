// commands/vd.js
//
// Owner-only.
// Success stays silent.
// .vd -> sends to OWNER_NUMBER
// .vd <number/jid> -> sends to specified destination

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

  return n ? `${n}@s.whatsapp.net` : null;
}

function normalizeDest(input) {
  const raw = String(input || "").trim();
  return raw ? toUserJid(raw) : null;
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
  name: "vd",
  aliases: ["vdowner", "v2dm"],
  category: "OWNER",
  description:
    "Owner-only: Extract replied view-once media and send it to destination.",

  async execute(ctx) {
    const { sock, m, from, args = [] } = ctx;

    const sender = getSender(m) || from;

    if (!isOwner(m, sock)) {
      const tag = tagOf(sender);

      return sock.sendMessage(
        from,
        {
          text: `❌ Owner only.\n\n${tag}`,
          mentions: sender ? [sender] : [],
        },
        { quoted: m }
      );
    }

    const dest =
      normalizeDest(args[0]) ||
      getOwnerDmJidFromEnv();

    if (!dest) {
      return sock.sendMessage(
        from,
        {
          text:
            "❌ OWNER_NUMBER is missing/invalid in .env.\n" +
            "Set: OWNER_NUMBER=237xxxxxxxxx",
        },
        { quoted: m }
      );
    }

    // 1. Command was not used on a view-once message.
    if (!isViewOnceQuoted(m)) {
      return sock.sendMessage(
        from,
        { text: "❌ Reply to a view once" },
        { quoted: m }
      );
    }

    // 2. It is view-once, but usable media is unavailable.
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

      // Success is intentionally silent in the source chat.
      if (cached.media.type === "image") {
        await sock.sendMessage(dest, {
          image: buffer,
          mimetype: cached.media.mimetype || "image/jpeg",
        });
        return;
      }

      if (cached.media.type === "video") {
        await sock.sendMessage(dest, {
          video: buffer,
          mimetype: cached.media.mimetype || "video/mp4",
        });
        return;
      }

      if (cached.media.type === "audio") {
        await sock.sendMessage(dest, {
          audio: buffer,
          mimetype: cached.media.mimetype || "audio/ogg; codecs=opus",
          ptt: Boolean(cached.media.media?.ptt),
        });
        return;
      }

      return sock.sendMessage(
        from,
        { text: "❌ No media" },
        { quoted: m }
      );
    } catch (error) {
      console.error("[vd] error:", error);

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
