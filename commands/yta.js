// commands/yta.js — BMEDIA-MD V6.1.0
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

function getInput(args = []) {
  const text = args.join(" ").trim();
  const url = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0];

  return url || text
    .replace(/^[.!/#]\s*(?:yta|ytmp3|youtubeaudio|play|song)\s+/i, "")
    .trim();
}

function decodeHeader(v = "") {
  try { return decodeURIComponent(v); } catch { return ""; }
}

async function downloadFromApi(input, filePath) {
  const base = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.YTDL_API_KEY || "").trim();

  const r = await safeFetch(`${base}/api/youtube`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ action: "audio", input }),
  });

  if (!r.ok) {
    let reason = `API error: HTTP ${r.status}`;
    try {
      const data = await r.json();
      reason = data?.error || reason;
    } catch {}
    throw new Error(reason);
  }

  const title = decodeHeader(r.headers.get("x-bmedia-title") || "") || "YouTube Audio";
  const stream = nodeStream(r.body);

  if (!stream) throw new Error("No audio returned by BMEDIA-YTDL.");

  const ws = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  const st = fs.statSync(filePath);
  if (!st.size) throw new Error("Downloaded audio is empty.");

  return { title };
}

function run(ctx, input) {
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

      const result = await downloadFromApi(input, filePath);

      await sock.sendMessage(
        from,
        {
          audio: { url: filePath },
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
    const input = getInput(args);

    if (!input) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}yta <YouTube link or song title>` },
        { quoted: m }
      );
    }

    run(ctx, input);
    return true;
  },
};
