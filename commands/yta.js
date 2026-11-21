// commands/yta.js — BMEDIA-MD V6.2.0
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

function cleanName(value = "") {
  return String(value || "YouTube Audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function pickInput(args = []) {
  const text = args.join(" ").trim();

  const url = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  return url?.[0] || text;
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

async function getAudio(input) {
  const { baseUrl, apiKey } = config();

  const response = await safeFetch(`${baseUrl}/youtube/audio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ input }),
  });

  const text = await response.text();
  let data = null;

  try { data = JSON.parse(text); } catch {}

  if (!response.ok) {
    throw new Error(data?.error || `API error: HTTP ${response.status}`);
  }

  if (!data?.status || !data?.mediaUrl) {
    throw new Error(data?.error || "Audio was not prepared.");
  }

  return data;
}

async function downloadMedia(url, filePath) {
  const response = await safeFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Audio media download failed: HTTP ${response.status}`);
  }

  const stream = toNodeStream(response.body);
  if (!stream) throw new Error("Audio media response had no body.");

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

  if (!stat.size || stat.size < 1000 || bytes < 1000) {
    throw new Error("Downloaded audio file is empty.");
  }

  return stat.size;
}

function start(ctx, input) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const dir = path.join(process.cwd(), "temp");
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(
      dir,
      `${Date.now()}_${Math.random().toString(16).slice(2)}.mp3`
    );

    try {
      await sock.sendMessage(from, {
        react: { text: "⏳", key: m.key },
      }).catch(() => {});

      const data = await getAudio(input);
      await downloadMedia(data.mediaUrl, filePath);

      const title = cleanName(data.title);

      await sock.sendMessage(
        from,
        {
          audio: { url: filePath },
          mimetype: "audio/mpeg",
          ptt: false,
          fileName: `${title}.mp3`,
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
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Download YouTube audio.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = pickInput(args);

    if (!input) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}yta <YouTube link or song title>` },
        { quoted: m }
      );
    }

    start(ctx, input);
    return true;
  },
};
