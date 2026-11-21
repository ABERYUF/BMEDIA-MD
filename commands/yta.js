// commands/yta.js
// BMEDIA-MD — YouTube audio via private BMEDIA-YTDL backend.
// Supports:
//   .yta <YouTube link>
//   .yta <song/search text>
//
// Required .env values on the MAIN WhatsApp bot:
//   YTDL_API_URL=https://YOUR-CODESPACE-3000.app.github.dev
//   YTDL_API_KEY=your_private_api_key

import { Readable } from "stream";

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

function titleFromFilename(fileName = "", fallback = "YouTube Audio") {
  const name = String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/_/g, " ")
    .trim();

  return name || fallback;
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

async function requestAudio(input) {
  const { baseUrl, apiKey } = apiConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    const fileName =
      filenameFromDisposition(response.headers.get("content-disposition")) ||
      "YouTube Audio.mp3";

    return {
      stream: Readable.fromWeb(response.body),
      fileName,
      title: titleFromFilename(fileName),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildCaption(title) {
  return [
    "╭─〔 *YOUTUBE AUDIO* 〕",
    `╰◦ *Title:* ${title || "YouTube Audio"}`,
    "",
    "> POWERED BY BMEDIA-MD",
  ].join("\n");
}

export default {
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Search for or download YouTube audio using BMEDIA-YTDL.",
  usage: "yta <YouTube link or song title>",

  // Main index.js should honor this per-command timeout.
  timeoutMs: REQUEST_TIMEOUT_MS,

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
          ].join("\n"),
        },
        { quoted: m }
      );
    }

    try {
      const media = await requestAudio(input);

      await sock.sendMessage(
        from,
        { text: buildCaption(media.title) },
        { quoted: m }
      );

      return await sock.sendMessage(
        from,
        {
          audio: { stream: media.stream },
          mimetype: "audio/mpeg",
          ptt: false,
          fileName: media.fileName,
        },
        { quoted: m }
      );
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "BMEDIA-YTDL took too long to respond."
          : error?.message || "Audio download failed.";

      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE AUDIO ERROR* 〕",
            `╰◦ ${message}`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        { quoted: m }
      );
    }
  },
};
