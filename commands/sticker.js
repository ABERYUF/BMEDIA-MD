// commands/sticker.js (ESM)

// "Device temp" style: uses wa-sticker-formatter (will use system temp by default).

// Reply to image/video => sticker.

// NOTE: On low-disk hosts, video stickers may fail with "No space left on device".

import { downloadContentFromMessage } from "@whiskeysockets/baileys";

import { Sticker, StickerTypes } from "wa-sticker-formatter";

const PACK_NAME = "BMEDIA-MD (Powered by BMEDIA)";

const PACK_AUTHOR = "BMEDIA";

const MAX_VIDEO_SECONDS = 6; // auto-trim

function getQuotedMessage(m) {

  const ext = m?.message?.extendedTextMessage;

  const ctxInfo = ext?.contextInfo;

  return ctxInfo?.quotedMessage || null;

}

async function streamToBuffer(stream) {

  const chunks = [];

  for await (const chunk of stream) chunks.push(chunk);

  return Buffer.concat(chunks);

}

async function downloadQuotedMediaBuffer(quotedMsg) {

  if (quotedMsg?.imageMessage) {

    const stream = await downloadContentFromMessage(quotedMsg.imageMessage, "image");

    const buffer = await streamToBuffer(stream);

    return { type: "image", buffer };

  }

  if (quotedMsg?.videoMessage) {

    const stream = await downloadContentFromMessage(quotedMsg.videoMessage, "video");

    const buffer = await streamToBuffer(stream);

    return { type: "video", buffer };

  }

  return null;

}

export default {

  name: "sticker",

  aliases: ["s", "st"],

  category: "TOOLS",

  description: "Reply to an image/video to make a sticker (BMEDIA-MD).",

  async execute(ctx) {

    const { sock, m, from } = ctx;

    const quoted = getQuotedMessage(m);

    if (!quoted) {

      return sock.sendMessage(

        from,

        { text: "Reply to an image or short video to convert to sticker." },

        { quoted: m }

      );

    }

    const media = await downloadQuotedMediaBuffer(quoted);

    if (!media) {

      return sock.sendMessage(

        from,

        { text: "Unsupported. Reply to an *image* or *video* only." },

        { quoted: m }

      );

    }

    try {

      const opts =

        media.type === "video"

          ? {

              pack: PACK_NAME,

              author: PACK_AUTHOR,

              type: StickerTypes.FULL,

              quality: 30,

              fps: 12,

              startTime: 0,

              endTime: MAX_VIDEO_SECONDS,

            }

          : {

              pack: PACK_NAME,

              author: PACK_AUTHOR,

              type: StickerTypes.FULL,

              quality: 70,

            };

      const sticker = new Sticker(media.buffer, opts);

      const stickerBuffer = await sticker.toBuffer();

      await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });

    } catch (e) {

      const msg = String(e?.message || e);

      return sock.sendMessage(from, { text: `❌ Sticker error: ${msg}` }, { quoted: m });

    }

  },

};