// commands/yta.js
// Uses private BMEDIA-YTDL backend and temp-file sending.
// Required on the MAIN bot host:
//   YTDL_API_URL=https://YOUR-CODESPACE-3000.app.github.dev
//   YTDL_API_KEY=your_private_api_key
//
// Designed to work with the ORIGINAL index.js by running the long job in
// a detached async task, so execute() returns quickly and avoids the global
// 15-second command timeout.

import fs from "fs";
import path from "path";
import os from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function apiConfig() {
  const baseUrl = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is not configured.");
  if (!apiKey) throw new Error("YTDL_API_KEY is not configured.");

  return { baseUrl, apiKey };
}

function filenameFromDisposition(value = "") {
  const raw = String(value || "");
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {}
  }

  const normal = raw.match(/filename="?([^";]+)"?/i);
  return normal?.[1] || "";
}

function safeBaseName(name = "", fallback = "YouTube Audio") {
  const base = String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return base || fallback;
}

function buildCaption(title) {
  return [
    "╭─〔 *YOUTUBE AUDIO* 〕",
    `╰◦ *Title:* ${title || "YouTube Audio"}`,
    "",
    "> POWERED BY BMEDIA-MD",
  ].join("
");
}

async function readApiError(response) {
  try {
    const data = await response.json();
    return data?.error || data?.details || `BMEDIA-YTDL returned HTTP ${response.status}.`;
  } catch {
    try {
      const text = await response.text();
      return text || `BMEDIA-YTDL returned HTTP ${response.status}.`;
    } catch {
      return `BMEDIA-YTDL returned HTTP ${response.status}.`;
    }
  }
}

async function requestAudioToTemp(input) {
  const { baseUrl, apiKey } = apiConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bmedia-yta-"));

  try {
    const response = await fetch(`${baseUrl}/youtube/audio`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    if (!response.body) {
      throw new Error("BMEDIA-YTDL returned no audio stream.");
    }

    const fileName = filenameFromDisposition(response.headers.get("content-disposition")) || "YouTube Audio.mp3";
    const finalPath = path.join(tempDir, fileName);

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(finalPath));

    return {
      tempDir,
      filePath: finalPath,
      fileName,
      title: safeBaseName(fileName),
    };
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupTemp(tempDir) {
  if (!tempDir) return;
  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

export default {
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Search for or download YouTube audio.",
  usage: "yta <YouTube link or song title>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = args.join(" ").trim();

    if (!input) {
      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE AUDIO* 〕",
            `├◦ ${prefix}yta <song title>`,
            `╰◦ ${prefix}yta <YouTube link>`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("
"),
        },
        { quoted: m }
      );
    }

    await sock.sendMessage(from, { react: { text: "⏳", key: m.key } }).catch(() => {});

    (async () => {
      let tempDir = "";
      try {
        const media = await requestAudioToTemp(input);
        tempDir = media.tempDir;

        await sock.sendMessage(
          from,
          { text: buildCaption(media.title) },
          { quoted: m }
        );

        const sent = await sock.sendMessage(
          from,
          {
            audio: { url: media.filePath },
            mimetype: "audio/mpeg",
            ptt: false,
            fileName: media.fileName,
          },
          { quoted: m }
        );

        await sock.sendMessage(from, { react: { text: "✅", key: m.key } }).catch(() => {});
        await cleanupTemp(tempDir);
        return sent;
      } catch (error) {
        await cleanupTemp(tempDir);
        await sock.sendMessage(from, { react: { text: "❌", key: m.key } }).catch(() => {});

        return sock.sendMessage(
          from,
          {
            text: [
              "╭─〔 *YOUTUBE AUDIO ERROR* 〕",
              `╰◦ ${error?.name === "AbortError" ? "BMEDIA-YTDL took too long to respond." : error?.message || "Audio download failed."}`,
              "",
              "> POWERED BY BMEDIA-MD",
            ].join("
"),
          },
          { quoted: m }
        );
      }
    })().catch(() => {});

    return true;
  },
};
