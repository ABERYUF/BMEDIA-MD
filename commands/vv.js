// commands/vv.js (ESM)
//
// Extract and resend View Once media.
// Uses the bot's existing incoming-message cache first so we work with the
// original WhatsApp message instead of the often-truncated quoted copy.

import {
  downloadContentFromMessage,
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { getCachedAntiDeleteMessage } from "../control/antiDeleteHandler.js";

const silentLogger = P({ level: "silent" });

function unwrapMessage(msg) {
  if (!msg) return null;

  // WhatsApp has used several wrappers for View Once / future-proof messages.
  // Keep unwrapping until we reach the real media payload.
  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
    "editedMessage",
    "associatedChildMessage",
    "groupStatusMessage",
    "groupStatusMessageV2",
  ];

  for (const key of wrappers) {
    const inner = msg?.[key]?.message;
    if (inner) return unwrapMessage(inner);
  }

  return msg;
}

function getQuotedContext(m) {
  const msg = unwrapMessage(m?.message) || m?.message || {};

  if (msg?.extendedTextMessage?.contextInfo) {
    return msg.extendedTextMessage.contextInfo;
  }

  for (const value of Object.values(msg || {})) {
    if (value?.contextInfo) return value.contextInfo;
  }

  return null;
}

function getQuotedMessage(m) {
  return getQuotedContext(m)?.quotedMessage || null;
}

function mediaInfoFromContent(content) {
  const root = unwrapMessage(content);
  if (!root) return null;

  const type = getContentType(root);

  if (type === "imageMessage" || root.imageMessage) {
    const media = root.imageMessage;
    if (media) return { kind: "image", media, caption: media.caption || "" };
  }

  if (type === "videoMessage" || root.videoMessage) {
    const media = root.videoMessage;
    if (media) return { kind: "video", media, caption: media.caption || "" };
  }

  if (type === "audioMessage" || root.audioMessage) {
    const media = root.audioMessage;
    if (media) {
      return {
        kind: "audio",
        media,
        caption: "",
        ptt: Boolean(media.ptt),
        mimetype: media.mimetype || "audio/ogg; codecs=opus",
      };
    }
  }

  return null;
}

function getOriginalQuotedWAMessage(m, from) {
  const contextInfo = getQuotedContext(m);
  if (!contextInfo) return null;

  const quotedId = contextInfo.stanzaId;

  // Best source: the exact original message already received by the bot.
  if (quotedId) {
    const cached = getCachedAntiDeleteMessage({
      remoteJid: from,
      id: quotedId,
      participant: contextInfo.participant,
    });

    if (cached?.message) return cached;
  }

  // Fallback for messages that arrived before this process started or were
  // trimmed from the cache. This still lets downloadMediaMessage handle a
  // complete quoted payload when WhatsApp included one.
  if (contextInfo.quotedMessage) {
    return {
      key: {
        remoteJid: from,
        fromMe: false,
        id: quotedId || `quoted-${Date.now()}`,
        participant: contextInfo.participant,
      },
      message: contextInfo.quotedMessage,
    };
  }

  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadFromMediaObject(info) {
  const stream = await downloadContentFromMessage(info.media, info.kind);
  return streamToBuffer(stream);
}

async function downloadWithRecovery(sock, fullMessage, info) {
  let firstError = null;

  // Preferred route. downloadMediaMessage understands wrappers and can use
  // WhatsApp's media retry/re-upload mechanism for expired CDN links.
  if (fullMessage?.message) {
    try {
      return await downloadMediaMessage(
        fullMessage,
        "buffer",
        {},
        {
          logger: sock?.logger || silentLogger,
          reuploadRequest: sock?.updateMediaMessage
            ? (msg) => sock.updateMediaMessage(msg)
            : undefined,
        }
      );
    } catch (err) {
      firstError = err;
      console.warn("[VV] Initial media download failed:", err?.message || err);
    }

    // Current Baileys releases have had cases where an expired 410 response
    // does not automatically trigger reuploadRequest. Explicitly request one
    // and retry before giving up.
    if (typeof sock?.updateMediaMessage === "function") {
      try {
        const refreshed = await sock.updateMediaMessage(fullMessage);
        const retryMessage = refreshed?.message ? refreshed : fullMessage;

        return await downloadMediaMessage(
          retryMessage,
          "buffer",
          {},
          {
            logger: sock?.logger || silentLogger,
            reuploadRequest: (msg) => sock.updateMediaMessage(msg),
          }
        );
      } catch (err) {
        console.warn("[VV] Media re-upload/retry failed:", err?.message || err);
      }
    }
  }

  // Last fallback: old low-level path. Useful when WhatsApp supplied a media
  // object but not enough surrounding WAMessage information.
  try {
    return await downloadFromMediaObject(info);
  } catch (err) {
    console.error("[VV] Direct media download failed:", err?.message || err);
    throw firstError || err;
  }
}

async function sendExtracted(sock, m, from, info, buffer) {
  if (!buffer?.length) throw new Error("Downloaded media was empty");

  const caption =
    `> *POWERED BY BMEDIA*` +
    (info.caption ? `\n*Caption:* ${info.caption}` : "");

  if (info.kind === "image") {
    return sock.sendMessage(from, { image: buffer, caption }, { quoted: m });
  }

  if (info.kind === "video") {
    const tempPath = path.join(tmpdir(), `vo_${Date.now()}.mp4`);

    try {
      await fs.writeFile(tempPath, buffer);
      return await sock.sendMessage(
        from,
        { video: { url: tempPath }, caption },
        { quoted: m }
      );
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  if (info.kind === "audio") {
    const ext = info.mimetype?.includes("mpeg") ? "mp3" : "ogg";
    const tempPath = path.join(tmpdir(), `vo_${Date.now()}.${ext}`);

    try {
      await fs.writeFile(tempPath, buffer);
      await sock.sendMessage(
        from,
        { text: `> *POWERED BY BMEDIA*` },
        { quoted: m }
      );

      return await sock.sendMessage(
        from,
        {
          audio: { url: tempPath },
          mimetype: info.mimetype || "audio/ogg; codecs=opus",
          ptt: Boolean(info.ptt),
        },
        { quoted: m }
      );
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  throw new Error(`Unsupported media type: ${info.kind}`);
}

async function handle(sock, m, from) {
  const quotedContext = getQuotedContext(m);

  if (!quotedContext?.quotedMessage && !quotedContext?.stanzaId) {
    return sock.sendMessage(
      from,
      { text: "❌ Please reply to a view-once image/video/voice-note to extract it." },
      { quoted: m }
    );
  }

  const originalMessage = getOriginalQuotedWAMessage(m, from);
  const sourceContent = originalMessage?.message || getQuotedMessage(m);
  const info = mediaInfoFromContent(sourceContent);

  if (!info) {
    // If key.isViewOnce arrived only as a WhatsApp stub, there is no encrypted
    // media payload for Baileys to decrypt. Make this distinction in logs while
    // keeping the user-facing response simple.
    console.warn(
      "[VV] View Once media payload unavailable.",
      JSON.stringify({
        quotedId: quotedContext?.stanzaId || null,
        cached: Boolean(originalMessage?.message),
      })
    );

    return sock.sendMessage(
      from,
      { text: "❌ View-once media could not be recovered. Try replying to it shortly after it is received." },
      { quoted: m }
    );
  }

  try {
    const buffer = await downloadWithRecovery(sock, originalMessage, info);
    return await sendExtracted(sock, m, from, info, buffer);
  } catch (err) {
    console.error("[VV] Extraction failed:", err);

    return sock.sendMessage(
      from,
      {
        text:
          "❌ Failed to extract the view-once media. " +
          "If it was just received, try again once; older media may no longer be recoverable.",
      },
      { quoted: m }
    );
  }
}

function pickSock(ctxOrSock) {
  return ctxOrSock?.sock || ctxOrSock?.conn || ctxOrSock?.client || ctxOrSock;
}

function pickMessage(ctxOrM) {
  return ctxOrM?.m || ctxOrM;
}

function pickFrom(ctx, m) {
  return ctx?.from || m?.key?.remoteJid || ctx?.chat || ctx?.jid;
}

const command = {
  name: "viewonce",
  aliases: ["vo", "vv"],
  category: "TOOLS",
  description: "Extract and resend view-once media.",

  async execute(ctx) {
    const sock = pickSock(ctx);
    const m = pickMessage(ctx);
    const from = pickFrom(ctx, m);
    return handle(sock, m, from);
  },

  async run(sock, m) {
    const from = m?.key?.remoteJid;
    return handle(sock, m, from);
  },
};

export { command };
export default command;
