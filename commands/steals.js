// commands/steals.js (ESM)

// Steal a sticker and resend it with packname "BMEDIA-MD" instantly.

// Usage: reply to a sticker with: <prefix>steals

//

// Dependency (required for packname/author):

//   npm i wa-sticker-formatter

//

// Notes:

// - Works for static + animated stickers

// - Rebuilds sticker with new pack metadata

import { downloadContentFromMessage } from "@whiskeysockets/baileys";

import { Sticker } from "wa-sticker-formatter";

async function streamToBuffer(stream) {

  const chunks = [];

  for await (const c of stream) chunks.push(c);

  return Buffer.concat(chunks);

}

function getQuotedMessage(m) {

  return m?.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

}

export default {

  name: "steals",

  aliases: ["steal", "stickersteal", "take"],

  category: "TOOLS",

  description: "Steal a sticker and resend it as BMEDIA-MD pack.",

  async execute(ctx) {

    const { sock, m, from } = ctx;

    const quoted = getQuotedMessage(m);

    const st = quoted?.stickerMessage;

    if (!st) {

      return sock.sendMessage(

        from,

        { text: "Reply to a sticker with: steals" },

        { quoted: m }

      );

    }

    try {

      const stream = await downloadContentFromMessage(st, "sticker");

      const stickerBuf = await streamToBuffer(stream);

      const isAnimated = Boolean(st.isAnimated);

      const outSticker = new Sticker(stickerBuf, {

        pack: "BMEDIA-MD",

        author: "BMEDIA",

        type: isAnimated ? "full" : "default", // keep animated as animated

        quality: 80,

      });

      const out = await outSticker.toBuffer();

      return sock.sendMessage(from, { sticker: out }, { quoted: m });

    } catch (e) {

      return sock.sendMessage(

        from,

        { text: `❌ steals error: ${e?.message || e}` },

        { quoted: m }

      );

    }

  },

};