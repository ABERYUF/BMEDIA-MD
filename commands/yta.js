// commands/yta.js — BMEDIA-MD V6.0.2
import fs from "fs";
import path from "path";
import { Readable } from "stream";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function nodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function cleanName(v) {
  return String(v || "YouTube Audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function getInput(args = []) {
  const text = args.join(" ").trim();
  const m = text.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i);
  return m?.[0] || text.replace(/^[.!/#]\s*(?:yta|ytmp3|youtubeaudio|play|song)\s+/i, "").trim();
}

async function getData(input) {
  const base = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.YTDL_API_KEY || "").trim();
  if (!base) throw new Error("YTDL_API_URL is missing.");
  if (!key) throw new Error("YTDL_API_KEY is missing.");

  const r = await safeFetch(`${base}/api/yta`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ input }),
  });

  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!r.ok) throw new Error(data?.error || `API error: HTTP ${r.status}`);
  if (!data?.status) throw new Error(data?.error || "Audio request failed.");
  if (!data.downloadUrl && !data.url) throw new Error("No audio URL returned.");

  return data;
}

async function download(url, filePath) {
  const r = await safeFetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`Audio download failed: HTTP ${r.status}`);

  const stream = nodeStream(r.body);
  if (!stream) throw new Error("Audio response had no body.");

  const ws = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });
}

function start(ctx, input) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const dir = path.join(process.cwd(), "temp");
    fs.mkdirSync(dir, { recursive: true });

    let filePath = "";

    try {
      await sock.sendMessage(from, { react: { text: "⏳", key: m.key } }).catch(() => {});

      const data = await getData(input);
      const title = cleanName(data.title);
      const ext = String(data.audio?.ext || data.fileName || "").toLowerCase().includes("m4a") ? "m4a" : "mp3";
      const mimetype = data.mimetype || (ext === "m4a" ? "audio/mp4" : "audio/mpeg");

      filePath = path.join(dir, `${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`);
      await download(data.downloadUrl || data.url, filePath);

      await sock.sendMessage(from, {
        audio: { url: filePath },
        mimetype,
        ptt: false,
        fileName: `${title}.${ext}`,
      }, { quoted: m });

      await sock.sendMessage(from, { react: { text: "✅", key: m.key } }).catch(() => {});
    } catch (e) {
      await sock.sendMessage(from, { react: { text: "❌", key: m.key } }).catch(() => {});
      await sock.sendMessage(from, {
        text: `❌ download unsuccessful\nReason: ${e?.message || e}`,
      }, { quoted: m }).catch(() => {});
    } finally {
      if (filePath) {
        try { fs.rmSync(filePath, { force: true }); } catch {}
      }
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
    const input = getInput(args);

    if (!input) {
      return sock.sendMessage(from, {
        text: `Usage: ${prefix}yta <YouTube link or song title>`,
      }, { quoted: m });
    }

    start(ctx, input);
    return true;
  },
};
