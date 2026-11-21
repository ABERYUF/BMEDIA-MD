// commands/ytv.js — BMEDIA-MD V6.1.0
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

function getUrl(args = []) {
  const text = args.join(" ").trim();
  return text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0] || "";
}

function decodeHeader(v = "") {
  try { return decodeURIComponent(v); } catch { return ""; }
}

async function downloadFromApi(url, filePath) {
  const base = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.YTDL_API_KEY || "").trim();

  const r = await safeFetch(`${base}/api/youtube`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ action: "video", input: url }),
  });

  if (!r.ok) {
    let reason = `API error: HTTP ${r.status}`;
    try {
      const data = await r.json();
      reason = data?.error || reason;
    } catch {}
    throw new Error(reason);
  }

  const title = decodeHeader(r.headers.get("x-bmedia-title") || "") || "YouTube Video";
  const stream = nodeStream(r.body);

  if (!stream) throw new Error("No video returned by BMEDIA-YTDL.");

  const ws = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  const st = fs.statSync(filePath);
  if (!st.size || st.size < 5000) {
    throw new Error("Downloaded video is invalid.");
  }

  return { title };
}

function run(ctx, url) {
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

      const result = await downloadFromApi(url, filePath);

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
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const url = getUrl(args);

    if (!url) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}ytv <YouTube link>` },
        { quoted: m }
      );
    }

    run(ctx, url);
    return true;
  },
};
