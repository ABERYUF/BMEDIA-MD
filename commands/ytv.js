// commands/ytv.js (ESM)

// FIXED like yta:

// - No .toString() crash (safe stderr handling)

// - Streams download to temp (no big RAM buffer)

// - ffmpeg remux to mp4

// - Sends using file path { video: { url: outPath } } (more stable on low RAM)

// - Delayed cleanup to prevent ENOENT while Baileys is still reading the file

import fs from "fs";

import path from "path";

import os from "os";

import { spawn } from "child_process";

import ffmpegPath from "ffmpeg-static";

// ----------------- Helpers -----------------

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

function cleanFileName(name) {

  return String(name || "video")

    .replace(/[\\/:*?"<>|]/g, "")

    .replace(/\s+/g, " ")

    .trim()

    .slice(0, 80);

}

function isOverloaded() {

  const usedMB = process.memoryUsage().rss / 1024 / 1024;

  const freeMB = os.freemem() / 1024 / 1024;

  // tuned for your 256MB server

  const maxRssMB = Number(process.env.MAX_RSS_MB || 185);

  const minFreeMB = Number(process.env.MIN_FREE_MB || 20);

  if (usedMB > maxRssMB) return `RAM high (${usedMB.toFixed(0)}MB > ${maxRssMB}MB)`;

  if (freeMB < minFreeMB) return `Low free RAM (${freeMB.toFixed(0)}MB < ${minFreeMB}MB)`;

  return "";

}

function startOverloadWatcher({ onAbort, intervalMs = 1200 }) {

  const it = setInterval(() => {

    const why = isOverloaded();

    if (why) onAbort(why);

  }, intervalMs);

  return () => clearInterval(it);

}

function safeToStr(d) {

  // ✅ prevents "reading toString of undefined"

  return d?.toString?.() ?? String(d ?? "");

}

function runFfmpeg(args, killHook) {

  return new Promise((resolve, reject) => {

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    if (typeof killHook === "function") {

      killHook(() => {

        try { p.kill("SIGKILL"); } catch {}

      });

    }

    let err = "";

    p.stderr.on("data", (d) => {

      err += safeToStr(d);

    });

    p.on("close", (code) => {

      if (code === 0) resolve(true);

      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-700)}`));

    });

  });

}

// Stream download to disk (NO buffering in RAM)

async function downloadToFile(url, filePath, { shouldAbort }) {

  const res = await safeFetch(url, {

    method: "GET",

    redirect: "follow",

    headers: {

      "user-agent": "Mozilla/5.0",

      accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",

    },

  });

  if (!res.ok) throw new Error(`File fetch failed: HTTP ${res.status}`);

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("text/html") || ct.includes("text/plain")) {

    throw new Error(`Download returned non-video content (${ct})`);

  }

  const body = res.body;

  if (!body) throw new Error("No response body from download server");

  const ws = fs.createWriteStream(filePath);

  // Node stream

  if (typeof body.pipe === "function") {

    await new Promise((resolve, reject) => {

      body.on("data", () => {

        if (shouldAbort?.()) {

          body.destroy(new Error("OVERLOAD"));

          ws.destroy(new Error("OVERLOAD"));

        }

      });

      body.on("error", reject);

      ws.on("error", reject);

      ws.on("finish", resolve);

      body.pipe(ws);

    }).catch((e) => {

      const msg = String(e?.message || "");

      if (msg.includes("OVERLOAD")) throw new Error("OVERLOAD");

      throw e;

    });

    const st = fs.statSync(filePath);

    if (!st.size || st.size < 5000) throw new Error("Downloaded file too small/invalid");

    return st.size;

  }

  // WebStream

  if (typeof body.getReader === "function") {

    const reader = body.getReader();

    try {

      while (true) {

        if (shouldAbort?.()) throw new Error("OVERLOAD");

        const { value, done } = await reader.read();

        if (done) break;

        if (value) ws.write(Buffer.from(value));

      }

      ws.end();

    } catch (e) {

      try { ws.destroy(); } catch {}

      throw e;

    }

    const st = fs.statSync(filePath);

    if (!st.size || st.size < 5000) throw new Error("Downloaded file too small/invalid");

    return st.size;

  }

  throw new Error("Unsupported response stream type");

}

export default {

  name: "ytv",

  aliases: ["ytmp4", "youtubevideo"],

  category: "DOWNLOAD",

  description: "Download YouTube video safely (low RAM, temp folder).",

  async execute(ctx) {

    const { sock, m, from, args, prefix } = ctx;

    const targetUrl = pickUrl(args);

    if (!targetUrl) {

      return sock.sendMessage(from, { text: `Usage: ${prefix}ytv <youtube link>` }, { quoted: m });

    }

    const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(targetUrl)}&format=mp4`;

    const tmpDir = path.join(process.cwd(), "temp");

    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const inPath = path.join(tmpDir, `${id}.source`);

    const outPath = path.join(tmpDir, `${id}.mp4`);

    let abortedByLoad = "";

    let killFfmpeg = null;

    const stopWatch = startOverloadWatcher({

      onAbort: (why) => {

        abortedByLoad = why;

        try { if (killFfmpeg) killFfmpeg(); } catch {}

      },

    });

    try {

      await sock.sendMessage(from, { text: "⏳ Processing... please wait." }, { quoted: m });

      try { await sock.sendPresenceUpdate?.("composing", from); } catch {}

      // 1) Get API JSON

      const res = await safeFetch(apiUrl, { method: "GET", headers: { accept: "application/json" } });

      if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

      const data = await res.json().catch(() => null);

      if (!data || data.success !== true) throw new Error(data?.message || "Invalid API response");

      const downloadURL = data.downloadURL || data.downloadUrl || data.url || data.link;

      const title = cleanFileName(data.title || "YouTube Video");

      if (!downloadURL || typeof downloadURL !== "string") throw new Error("No valid downloadURL");

      // 2) Download -> temp

      await downloadToFile(downloadURL, inPath, {

        shouldAbort: () => {

          const why = isOverloaded();

          if (why) abortedByLoad = why;

          return !!why;

        },

      });

      if (abortedByLoad) throw new Error("OVERLOAD");

      // 3) Remux to WhatsApp-friendly mp4

      await runFfmpeg(

        [

          "-y",

          "-i", inPath,

          "-movflags", "+faststart",

          "-c:v", "copy",

          "-c:a", "aac",

          "-b:a", "128k",

          outPath,

        ],

        (killer) => { killFfmpeg = killer; }

      );

      if (!fs.existsSync(outPath)) throw new Error("Output mp4 not found (remux failed)");

      // 4) Send using file path (more stable than manual stream)

      await sock.sendMessage(

        from,

        {

          video: { url: outPath },

          mimetype: "video/mp4",

          caption: `✅ ${data.title || title}`,

        },

        { quoted: m }

      );

      return;

    } catch (e) {

      const reason = String(e?.message || e || "Unknown error");

      if (reason.includes("OVERLOAD") || abortedByLoad) {

        return sock.sendMessage(

          from,

          { text: `❌ download unsuccessful\nReason: Stopped to protect server: ${abortedByLoad || "Overload detected"}` },

          { quoted: m }

        );

      }

      return sock.sendMessage(

        from,

        { text: `❌ download unsuccessful\nReason: ${reason}` },

        { quoted: m }

      );

    } finally {

      stopWatch();

      try { await sock.sendPresenceUpdate?.("paused", from); } catch {}

      // ✅ IMPORTANT: delayed cleanup to prevent ENOENT while Baileys still reads the file

      setTimeout(() => {

        try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch {}

        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}

      }, 90_000); // 90s delay

    }

  },

};