// commands/fb.js (ESM)

// Uses: https://eliteprotech-apis.zone.id/bmedia?url=<video_url>

// Expected JSON: { success:true, video:"mp4 url", thumbnail:"", author:"", source:"" }

// ✅ Downloads bytes on bot + remux to clean MP4, then sends to WhatsApp.

//

// Usage: !fb <facebook video url>

// Aliases: fbdl, fbvideo

import fs from "fs";

import path from "path";

import { spawn } from "child_process";

import ffmpegPath from "ffmpeg-static";

function cleanupTemp(maxAgeMinutes = 30) {

  const dir = path.join(process.cwd(), "temp");

  if (!fs.existsSync(dir)) return;

  const now = Date.now();

  for (const f of fs.readdirSync(dir)) {

    const p = path.join(dir, f);

    try {

      const st = fs.statSync(p);

      if (now - st.mtimeMs > maxAgeMinutes * 60 * 1000) fs.unlinkSync(p);

    } catch {}

  }

}

async function safeFetch(url, opts) {

  if (globalThis.fetch) return fetch(url, opts);

  const mod = await import("node-fetch");

  return mod.default(url, opts);

}

function pickUrl(args) {

  const s = (args || []).join(" ").trim();

  const m = s.match(/https?:\/\/\S+/i);

  return m ? m[0] : "";

}

async function fetchToBuffer(url) {

  const res = await safeFetch(url, {

    method: "GET",

    redirect: "follow",

    headers: {

      "user-agent": "Mozilla/5.0",

      "accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",

    },

  });

  if (!res.ok) throw new Error(`Video fetch failed: HTTP ${res.status}`);

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("text/html") || ct.includes("text/plain")) {

    throw new Error(`Download returned non-video content (${ct})`);

  }

  const arr = await res.arrayBuffer();

  const buf = Buffer.from(arr);

  if (buf.length < 5000) throw new Error("Downloaded video is too small / invalid");

  return buf;

}

function runFfmpeg(args) {

  return new Promise((resolve, reject) => {

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    let err = "";

    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {

      if (code === 0) resolve(true);

      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-700)}`));

    });

  });

}

async function remuxToMp4(inputBuf) {

  const tmpDir = path.join(process.cwd(), "temp");

  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const inPath = path.join(tmpDir, `${id}.bin`);

  const outPath = path.join(tmpDir, `${id}.mp4`);

  fs.writeFileSync(inPath, inputBuf);

  // Remux to MP4 for WhatsApp compatibility (+faststart helps streaming)

  await runFfmpeg([

    "-y",

    "-i", inPath,

    "-movflags", "+faststart",

    "-c:v", "copy",

    "-c:a", "aac",

    "-b:a", "128k",

    outPath,

  ]);

  const mp4Buf = fs.readFileSync(outPath);

  try { fs.unlinkSync(inPath); } catch {}

  try { fs.unlinkSync(outPath); } catch {}

  if (!mp4Buf || mp4Buf.length < 5000) throw new Error("Remuxed MP4 invalid");

  return mp4Buf;

}

export default {

  name: "fb",

  aliases: ["facebook", "fbvideo"],

  category: "DOWNLOAD",

  description: "Download Facebook video (via eliteprotech bmedia API).",

  async execute(ctx) {

    const { sock, m, from, args, prefix } = ctx;

    const targetUrl = pickUrl(args);

    if (!targetUrl) {

      return sock.sendMessage(

        from,

        { text: `Usage: ${prefix}fb <facebook video link>` },

        { quoted: m }

      );

    }

    const apiUrl = `https://eliteprotech-apis.zone.id/facebook?url=${encodeURIComponent(targetUrl)}`;

    try {

      await sock.sendMessage(from, { text: "⏳ Processing video... please wait." }, { quoted: m });

      try { await sock.sendPresenceUpdate?.("composing", from); } catch {}

      // 1) Get JSON

      const res = await safeFetch(apiUrl, { method: "GET", headers: { accept: "application/json" } });

      if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

      const data = await res.json().catch(() => null);

      if (!data || data.success !== true) throw new Error(data?.message || "Invalid API response");

      const videoUrl = data.video || data.mp4 || data.url || data.downloadURL || data.downloadUrl;

      if (!videoUrl || typeof videoUrl !== "string") throw new Error("No video URL found in API response");

      // 2) Download bytes ourselves

      const rawBuf = await fetchToBuffer(videoUrl);

      // 3) Remux to clean MP4

      const mp4Buf = await remuxToMp4(rawBuf);

      const caption =

        `✅ *FB Video Downloaded*`;

      // 4) Send video buffer

      const sent = await sock.sendMessage(

        from,

        {

          video: mp4Buf,

          mimetype: "video/mp4",

          caption: caption.trim(),

        },

        { quoted: m }

      );

      cleanupTemp(30);

      return sent;

    } catch (e) {

      return sock.sendMessage(from, { text: `❌ Failed: ${e?.message || e}` }, { quoted: m });

    } finally {

      try { await sock.sendPresenceUpdate?.("paused", from); } catch {}

      cleanupTemp(30);

    }

  },

};