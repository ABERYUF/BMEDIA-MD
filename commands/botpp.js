// commands/botpp.js (ESM) — FFmpeg-free logo update
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { isOwner } from "../checks/isOwner.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_SIDE = 2048;

function getContextInfo(m) {
  const msg = m?.message || {};
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.buttonsResponseMessage?.contextInfo ||
    msg.listResponseMessage?.contextInfo ||
    msg.templateButtonReplyMessage?.contextInfo ||
    null
  );
}

function getQuotedImageMessage(m) {
  const ctx = getContextInfo(m);
  const quoted = ctx?.quotedMessage || null;
  if (!quoted) return null;

  if (quoted.imageMessage) return quoted.imageMessage;

  if (quoted.viewOnceMessage?.message?.imageMessage) {
    return quoted.viewOnceMessage.message.imageMessage;
  }

  if (quoted.viewOnceMessageV2?.message?.imageMessage) {
    return quoted.viewOnceMessageV2.message.imageMessage;
  }

  if (quoted.viewOnceMessageV2Extension?.message?.imageMessage) {
    return quoted.viewOnceMessageV2Extension.message.imageMessage;
  }

  return null;
}

async function downloadQuotedImageBuffer(imageMsg) {
  const stream = await downloadContentFromMessage(imageMsg, "image");
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 20 MB.");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error("Invalid image data.");
  return Buffer.concat(chunks);
}

async function convertToPng(buffer) {
  // Lazy imports keep the command loadable even if a native library is missing.
  let sharpError;
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(buffer, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (error) {
    sharpError = error;
  }
  // Jimp is already installed in BMEDIA-MD and MINI; no FFmpeg executable needed.
  try {
    const { Jimp } = await import("jimp");
    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    if (width * height > MAX_PIXELS) throw new Error("Image dimensions are too large.");
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    if (scale < 1) image.resize({ w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) });
    return await image.getBuffer("image/png");
  } catch (error) {
    console.warn("[botpp] Image conversion failed:", sharpError?.code || sharpError?.message, error?.code || error?.message);
    throw new Error("Could not convert image. Try a valid JPEG or PNG image.");
  }
}

export default {
  name: "botpp",
  aliases: ["setbotpp", "botlogo", "setlogo"],
  category: "OWNER",
  description: "Replace assets/logo.png with a replied image.",
  usage: "botpp (reply to an image)",

  async execute(ctx) {
    const { sock, m, from, senderJid, sender } = ctx;
    if (!isOwner({ senderJid: senderJid || sender })) {
      return sock.sendMessage(from, { text: "❌ Owner only." }, { quoted: m });
    }
    const quotedImage = getQuotedImageMessage(m);
    if (!quotedImage) {
      return sock.sendMessage(from, { text: "❌ Reply to an image to set it as the bot picture." }, { quoted: m });
    }

    // MINI forks each bot with its own cwd. Keep the logo in that bot's assets.
    const assetsDir = path.join(process.cwd(), "assets");
    const logoPath = path.join(assetsDir, "logo.png");
    const pendingPath = path.join(assetsDir, `.logo-${randomUUID()}.tmp`);
    let png;
    try {
      const imageBuffer = await downloadQuotedImageBuffer(quotedImage);
      png = await convertToPng(imageBuffer);
      // Never remove the current logo before a replacement is ready.
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(pendingPath, png, { flag: "wx" });
      await fs.rename(pendingPath, logoPath);
    } catch (error) {
      return sock.sendMessage(from, { text: `❌ Failed to update bot image\nReason: ${error?.message || error}` }, { quoted: m });
    } finally {
      await fs.rm(pendingPath, { force: true }).catch(() => {});
    }
    return sock.sendMessage(from, {
      image: png,
      caption: "✅ Bot menu image updated\n\n> POWERED BY BMEDIA",
    }, { quoted: m });
  },
};
