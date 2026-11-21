// commands/ytv.js
// BMEDIA-MD — YouTube video via private BMEDIA-YTDL backend.
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

function isYouTubeUrl(value = "") {
  try {
    const u = new URL(String(value || "").trim());
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be"
    );
  } catch {
    return false;
  }
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

function titleFromFilename(fileName = "", fallback = "YouTube Video") {
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

async function requestVideo(url) {
  const { baseUrl, apiKey } = apiConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/youtube/video`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    if (!response.body) {
      throw new Error("BMEDIA-YTDL returned no video stream.");
    }

    const fileName =
      filenameFromDisposition(response.headers.get("content-disposition")) ||
      "YouTube Video.mp4";

    const contentLength = Number(response.headers.get("content-length") || 0);

    return {
      stream: Readable.fromWeb(response.body),
      fileName,
      title: titleFromFilename(fileName),
      contentLength,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatBytes(bytes = 0) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function buildCaption(title, size = 0) {
  const rows = [`*${title || "YouTube Video"}*`];
  const sizeText = formatBytes(size);
  if (sizeText) rows.push(`Size: ${sizeText}`);

  return [
    "╭─〔 *YOUTUBE VIDEO* 〕",
    ...rows.map((row, i) => `${i === rows.length - 1 ? "╰◦" : "├◦"} ${row}`),
    "",
    "> POWERED BY BMEDIA-MD",
  ].join("\n");
}

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video using BMEDIA-YTDL.",
  usage: "ytv <YouTube link>",

  // Main index.js should honor this per-command timeout.
  timeoutMs: REQUEST_TIMEOUT_MS,

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = args.join(" ").trim();

    if (!isYouTubeUrl(input)) {
      return sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *YOUTUBE VIDEO* 〕\n` +
            `╰◦ Usage: ${prefix}ytv <YouTube link>\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      );
    }

    try {
      const media = await requestVideo(input);

      return await sock.sendMessage(
        from,
        {
          video: { stream: media.stream },
          mimetype: "video/mp4",
          caption: buildCaption(media.title, media.contentLength),
          fileName: media.fileName,
        },
        { quoted: m }
      );
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "BMEDIA-YTDL took too long to respond."
          : error?.message || "Video download failed.";

      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE VIDEO ERROR* 〕",
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
