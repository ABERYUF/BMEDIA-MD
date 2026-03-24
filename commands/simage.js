// commands/simage.js (ESM)

// Convert a sticker to a PHOTO (PNG).

// Usage: reply a sticker with: <prefix>photo

//

// Requires ffmpeg installed on the host.

import fs from "fs";

import os from "os";

import path from "path";

import { promisify } from "util";

import { execFile } from "child_process";

import { downloadContentFromMessage } from "@whiskeysockets/baileys";

const execFileAsync = promisify(execFile);

async function streamToBuffer(stream) {

  const chunks = [];

  for await (const c of stream) chunks.push(c);

  return Buffer.concat(chunks);

}

function getQuotedMessage(m) {

  return m?.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

}

function tmpFile(ext) {

  return path.join(

    os.tmpdir(),

    `bmedia_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`

  );

}

export default {

  name: "simage",

  aliases: [],

  category: "TOOLS",

  description: "Convert sticker to photo (reply a sticker).",

  async execute(ctx) {

    const { sock, m, from } = ctx;

    const quoted = getQuotedMessage(m);

    if (!quoted || !quoted.stickerMessage) {

      return sock.sendMessage(

        from,

        { text: "Reply to a sticker with: photo" },

        { quoted: m }

      );

    }

    const inPath = tmpFile("webp");

    const outPath = tmpFile("png");

    try {

      const stream = await downloadContentFromMessage(quoted.stickerMessage, "sticker");

      const stickerBuf = await streamToBuffer(stream);

      if (!Buffer.isBuffer(stickerBuf) || stickerBuf.length < 500) {

        throw new Error("Sticker download failed / empty.");

      }

      fs.writeFileSync(inPath, stickerBuf);

      // Convert WEBP -> PNG (photo)

      await execFileAsync("ffmpeg", [

        "-y",

        "-i", inPath,

        "-vframes", "1",

        outPath,

      ]);

      const pngBuf = fs.readFileSync(outPath);

      if (!pngBuf || pngBuf.length < 1000) {

        throw new Error("PNG conversion produced empty output.");

      }

      await sock.sendMessage(

        from,

        {

          image: pngBuf,

          caption: "converted by BMEDIA-MD",

        },

        { quoted: m }

      );

    } catch (e) {

      const msg = String(e?.message || e);

      return sock.sendMessage(

        from,

        { text: `❌ Photo error: ${msg}\n\n(Ensure ffmpeg is installed on the host)` },

        { quoted: m }

      );

    } finally {

      try { fs.unlinkSync(inPath); } catch {}

      try { fs.unlinkSync(outPath); } catch {}

    }

  },

};