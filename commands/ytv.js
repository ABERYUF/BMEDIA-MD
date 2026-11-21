// commands/ytv.js — BMEDIA-MD V6.2.0
// YTS is NOT touched.

import fs from "fs";
import path from "path";
import { Readable } from "stream";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function pickUrl(args = []) {
  const text = args.join(" ").trim();

  return text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0] || "";
}

function cleanName(value = "") {
  return String(value || "YouTube Video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function config() {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  return { baseUrl, apiKey };
}

async function getVideo(url) {
  const { baseUrl, apiKey } = config();

  const response = await safeFetch(`${baseUrl}/youtube/video`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url }),
  });

  const text = await response.text();
  let data = null;

  try { data = JSON.parse(text); } catch {}

  if (!response.ok) {
    throw new Error(data?.error || `API error: HTTP ${response.status}`);
  }

  if (!data?.status || !data?.mediaUrl) {
    throw new Error(data?.error || "Video was not prepared.");
  }

  return data;
}

async function downloadMedia(url, filePath) {
  const response = await safeFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Video media download failed: HTTP ${response.status}`);
  }

  const stream = toNodeStream(response.body);
  if (!stream) throw new Error("Video media response had no body.");

  const ws = fs.createWriteStream(filePath);
  let bytes = 0;

  await new Promise((resolve, reject) => {
    stream.on("data", chunk => {
      bytes += chunk?.length || 0;
    });

    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  const stat = fs.statSync(filePath);

  if (!stat.size || stat.size < 5000 || bytes < 5000) {
    throw new Error("Downloaded video is invalid.");
  }

  return stat.size;
}

function start(ctx, url) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const dir = path.join(process.cwd(), "download_temp");
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(
      dir,
      `${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`
    );

    try {
      await sock.sendMessage(from, {
        react: { text: "⏳", key: m.key },
      }).catch(() => {});

      const data = await getVideo(url);
      await downloadMedia(data.mediaUrl, filePath);

      const title = cleanName(data.title);

      await sock.sendMessage(
        from,
        {
          video: { url: filePath },
          mimetype: "video/mp4",
          caption: title,
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
      try { fs.rmSync(filePath, { force: true }); } catch {}
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

    start(ctx, url);
    return true;
  },
};
