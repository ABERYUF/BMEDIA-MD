// commands/tiktok.js (ESM)

// Low-RAM / anti-overload TikTok/BmediTok downloader using your API:

// https://eliteprotech-apis.zone.id/tiktok?url=<video_url>

// Sends: video + "✅ video downloaded\n<title>"

import fs from "fs";

import path from "path";

import { pipeline, Readable } from "stream";

import { promisify } from "util";

import { spawn } from "child_process";

import ffmpegPath from "ffmpeg-static";

const pipe = promisify(pipeline);

async function safeFetch(url, opts) {

  if (globalThis.fetch) return fetch(url, opts);

  const mod = await import("node-fetch");

  return mod.default(url, opts);

}

function pickUrl(args) {

  const s = (args || []).filter(Boolean).join(" ").trim();

  const m = s.match(/https?:\/\/\S+/i);

  return m ? m[0] : "";

}

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

// Simple global concurrency limiter

const MAX_CONCURRENT = Math.max(1, Number(process.env.DL_CONCURRENCY || 1));

let active = 0;

const waitQ = [];

async function withLock(fn) {

  if (active >= MAX_CONCURRENT) await new Promise((res) => waitQ.push(res));

  active++;

  try {

    return await fn();

  } finally {

    active--;

    const next = waitQ.shift();

    if (next) next();

  }

}

function runFfmpeg(args) {

  return new Promise((resolve, reject) => {

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    let err = "";

    p.stderr.on("data", (d) => {

      // safe on odd chunks

      err += (d?.toString?.() ?? String(d ?? ""));

    });

    p.on("close", (code) => {

      if (code === 0) resolve(true);

      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-700)}`));

    });

  });

}

/**

 * Convert fetch body (web stream or node stream) to a Node Readable

 */

function toNodeReadable(body) {

  if (!body) return null;

  // node stream

  if (typeof body.pipe === "function") return body;

  // web stream (Node 18+ fetch)

  if (typeof body.getReader === "function") {

    if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);

    const reader = body.getReader();

    return new Readable({

      async read() {

        try {

          const { value, done } = await reader.read();

          if (done) this.push(null);

          else this.push(Buffer.from(value));

        } catch (e) {

          this.destroy(e);

        }

      },

    });

  }

  return null;

}

/**

 * Stream remote video -> input file (no buffering in RAM)

 */

async function downloadToFile(url, filePath) {

  const ctrl = new AbortController();

  const timeoutMs = Math.max(10_000, Number(process.env.DL_TIMEOUT_MS || 120_000));

  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {

    const res = await safeFetch(url, {

      method: "GET",

      redirect: "follow",

      signal: ctrl.signal,

      headers: {

        "user-agent": "Mozilla/5.0",

        accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",

      },

    });

    if (!res.ok) throw new Error(`Video fetch failed: HTTP ${res.status}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("text/html") || ct.includes("text/plain")) {

      throw new Error(`Download returned non-video content (${ct})`);

    }

    const maxMB = Number(process.env.MAX_VIDEO_MB || 25);

    const len = Number(res.headers.get("content-length") || 0);

    if (len && len > maxMB * 1024 * 1024) {

      throw new Error(

        `Video too large (${(len / 1024 / 1024).toFixed(1)}MB). Limit: ${maxMB}MB`

      );

    }

    const nodeReadable = toNodeReadable(res.body);

    if (!nodeReadable) throw new Error("Unsupported response body stream type");

    await pipe(nodeReadable, fs.createWriteStream(filePath));

    const st = fs.statSync(filePath);

    if (!st.size || st.size < 5000) throw new Error("Downloaded file too small/invalid");

    if (st.size > maxMB * 1024 * 1024) {

      throw new Error(

        `Video too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Limit: ${maxMB}MB`

      );

    }

    return st.size;

  } finally {

    clearTimeout(t);

  }

}

async function remuxFileToMp4(inPath, outPath) {

  await runFfmpeg([

    "-y",

    "-i", inPath,

    "-movflags", "+faststart",

    "-c:v", "copy",

    "-c:a", "aac",

    "-b:a", "128k",

    outPath,

  ]);

  const st = fs.statSync(outPath);

  if (!st.size || st.size < 5000) throw new Error("Remuxed MP4 invalid");

  return st.size;

}

export default {

  name: "tiktok",

  aliases: ["ttdl"],

  category: "DOWNLOAD",

  description: "Download BmediTok (TikTok-like) video and send it (safe mode).",

  async execute(ctx) {

    const { sock, m, from, args, prefix } = ctx;

    const targetUrl = pickUrl(args);

    if (!targetUrl) {

      return sock.sendMessage(from, { text: `Usage: ${prefix}tiktok <link>` }, { quoted: m });

    }

    const apiUrl = `https://eliteprotech-apis.zone.id/tiktok?url=${encodeURIComponent(targetUrl)}`;

    return withLock(async () => {

      const tmpDir = path.join(process.cwd(), "temp");

      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

      const inPath = path.join(tmpDir, `${id}.input`);

      const outPath = path.join(tmpDir, `${id}.mp4`);

      try {

        await sock.sendMessage(from, { text: "⏳ Processing... please wait." }, { quoted: m });

        try { await sock.sendPresenceUpdate?.("composing", from); } catch {}

        // 1) Fetch JSON

        const res = await safeFetch(apiUrl, { method: "GET", headers: { accept: "application/json" } });

        if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

        const data = await res.json().catch(() => null);

        if (!data || data.success !== true) throw new Error(data?.message || "Invalid API response");

        const title = String(data.title || "").trim() || "Untitled";

        // prefer SD by default; allow HD if user adds "hd"

        const wantsHD = (args || []).some((x) => String(x || "").toLowerCase() === "hd");

        const videoUrl = wantsHD ? (data.mp4_hd || data.mp4) : (data.mp4 || data.mp4_hd);

        if (!videoUrl) {

          return sock.sendMessage(from, { text: "❌ No MP4 video found." }, { quoted: m });

        }

        // 2) Stream download to disk

        await downloadToFile(videoUrl, inPath);

        // 3) Remux to MP4

        await remuxFileToMp4(inPath, outPath);

        if (!fs.existsSync(outPath)) throw new Error("Output file missing after remux");

        // ✅ 4) Send using file path (prevents ENOENT / toString crash)

        const sent = await sock.sendMessage(

          from,

          { video: { url: outPath }, mimetype: "video/mp4", caption: `✅ video downloaded\n${title}` },

          { quoted: m }

        );

        // keep file briefly; cleanup removes later

        cleanupTemp(30);

        return sent;

      } catch (e) {

        return sock.sendMessage(from, { text: `❌ Failed: ${e?.message || e}` }, { quoted: m });

      } finally {

        // ✅ safe to delete only the input file

        try { fs.existsSync(inPath) && fs.unlinkSync(inPath); } catch {}

        // ❌ DO NOT delete outPath here (Baileys may still read it)

        try { await sock.sendPresenceUpdate?.("paused", from); } catch {}

        cleanupTemp(30);

      }

    });

  },

};