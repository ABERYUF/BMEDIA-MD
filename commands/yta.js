// commands/yta.js (ESM)
// BMEDIA-MD — YouTube audio using private BMEDIA-YTDL.
// Same command-object format as the old BMEDIA-MD commands.

import fs from "fs";
import path from "path";
import { Readable } from "stream";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function pickInput(args) {
  const s = (args || []).join(" ").trim();

  const url = s.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  // If a YouTube link exists anywhere in the arguments, send only that link.
  if (url?.[0]) return url[0];

  // Also tolerate accidental ".yta query" / ".ytv link" text in args.
  return s
    .replace(/^[.!/#]\s*(?:yta|ytv|ytmp3|ytmp4|yts|ytsearch)\s+/i, "")
    .trim();
}

function ensureTempDir() {
  const dir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanFileName(name) {
  return String(name || "YouTube Audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function responseBodyToNodeReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function getHeaderTitle(response) {
  const encoded = String(response.headers.get("x-bmedia-title") || "");

  if (!encoded) return "";

  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

async function readApiError(response) {
  try {
    const data = await response.json();
    return data?.error || data?.details || `API error: HTTP ${response.status}`;
  } catch {
    return `API error: HTTP ${response.status}`;
  }
}

async function downloadAudio(input, outPath) {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  const response = await safeFetch(`${baseUrl}/youtube/audio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const stream = responseBodyToNodeReadable(response.body);
  if (!stream) throw new Error("No audio returned by BMEDIA-YTDL.");

  const ws = fs.createWriteStream(outPath);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  const stat = fs.existsSync(outPath) ? fs.statSync(outPath) : null;
  if (!stat?.size) throw new Error("Downloaded audio is empty.");

  return {
    title: cleanFileName(getHeaderTitle(response) || "YouTube Audio"),
  };
}

function runDownload(ctx, input) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const tempDir = ensureTempDir();
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const mp3Path = path.join(tempDir, `${id}.mp3`);

    await sock.sendMessage(from, {
      react: { text: "⏳", key: m.key },
    }).catch(() => {});

    try {
      await sock.sendMessage(
        from,
        { text: "⏳ Processing... please wait." },
        { quoted: m }
      );

      const result = await downloadAudio(input, mp3Path);

      await sock.sendMessage(
        from,
        {
          audio: { url: mp3Path },
          mimetype: "audio/mpeg",
          ptt: false,
          fileName: `${result.title}.mp3`,
        },
        { quoted: m }
      );

      await sock.sendMessage(from, {
        react: { text: "✅", key: m.key },
      }).catch(() => {});
    } catch (e) {
      await sock.sendMessage(from, {
        react: { text: "❌", key: m.key },
      }).catch(() => {});

      await sock.sendMessage(
        from,
        { text: `❌ download unsuccessful\nReason: ${e?.message || e}` },
        { quoted: m }
      ).catch(() => {});
    } finally {
      try {
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
      } catch {}
    }
  }, 250);
}

export default {
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Search for or download YouTube audio.",

  async execute(ctx) {
    const { sock, m, from, args, prefix } = ctx;
    const input = pickInput(args);

    if (!input) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}yta <youtube link or song title>` },
        { quoted: m }
      );
    }

    runDownload(ctx, input);
    return true;
  },
};
