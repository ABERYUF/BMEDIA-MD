// commands/ytv.js (ESM)
// BMEDIA-MD — YouTube video using private BMEDIA-YTDL.
// Built to match the same simple env/auth style as the working yts.js.

import fs from "fs";
import path from "path";
import { Readable } from "stream";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function apiConfig() {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  return { baseUrl, apiKey };
}

function pickUrl(args = []) {
  const q = args.join(" ").trim();

  const url = q.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  return url?.[0] || "";
}

function cleanName(value = "") {
  return String(value || "YouTube Video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function decodeHeader(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

async function downloadVideo(url, filePath) {
  const { baseUrl, apiKey } = apiConfig();

  const response = await safeFetch(`${baseUrl}/youtube/video`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    let reason = `API error: HTTP ${response.status}`;

    try {
      const data = await response.json();
      reason = data?.error || data?.message || reason;
    } catch {}

    throw new Error(reason);
  }

  const title =
    decodeHeader(response.headers.get("x-bmedia-title") || "") ||
    "YouTube Video";

  const body = toNodeStream(response.body);
  if (!body) throw new Error("No video returned by BMEDIA-YTDL.");

  const ws = fs.createWriteStream(filePath);
  let bytes = 0;

  await new Promise((resolve, reject) => {
    body.on("data", chunk => {
      bytes += chunk?.length || 0;
    });

    body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    body.pipe(ws);
  });

  if (bytes < 5000) {
    throw new Error("Downloaded video is invalid.");
  }

  return { title: cleanName(title) };
}

function runDownload(ctx, url) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const tempDir = path.join(process.cwd(), "download_temp");
    fs.mkdirSync(tempDir, { recursive: true });

    const filePath = path.join(
      tempDir,
      `${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`
    );

    try {
      await sock.sendMessage(from, {
        react: { text: "⏳", key: m.key },
      }).catch(() => {});

      const result = await downloadVideo(url, filePath);

      await sock.sendMessage(
        from,
        {
          video: { url: filePath },
          mimetype: "video/mp4",
          caption: result.title,
        },
        { quoted: m }
      );

      await sock.sendMessage(from, {
        react: { text: "✅", key: m.key },
      }).catch(() => {});
    } catch (error) {
      await sock.sendMessage(from, {
        react: { text: "❌", key: m.key },
      }).catch(() => {});

      await sock.sendMessage(
        from,
        { text: `❌ download unsuccessful\nReason: ${error?.message || error}` },
        { quoted: m }
      ).catch(() => {});
    } finally {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
    }
  }, 250);
}

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const url = pickUrl(args);

    if (!url) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}ytv <YouTube link>` },
        { quoted: m }
      );
    }

    runDownload(ctx, url);
    return true;
  },
};
