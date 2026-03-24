// commands/yta.js (ESM)

// Keeps the old behaviour (download -> ffmpeg -> send)

// BUT: prevents server crash on timeout and prevents ENOENT + undefined toString.

//

// - No MAX_MB / MIN_FREE / DL_CONCURRENCY / MAX_LOAD

// - Internal timeout (default 260s) so it replies before your index timeout (often 300s)

// - If timeout/ffmpeg fails: sends "❌ download unsuccessful" + reason + sizes

// - Deletes temp files ONLY in finally (never earlier)

import fs from "fs";

import path from "path";

import { spawn } from "child_process";

import ffmpegPath from "ffmpeg-static";

// ---------------- Helpers ----------------

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

function ensureTempDir() {

  const dir = path.join(process.cwd(), "temp");

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return dir;

}

function cleanFileName(name) {

  return String(name || "audio")

    .replace(/[\\/:*?"<>|]/g, "")

    .replace(/\s+/g, " ")

    .trim()

    .slice(0, 80);

}

function formatBytes(bytes) {

  const n = Number(bytes || 0);

  if (!n) return "0B";

  const units = ["B", "KB", "MB", "GB"];

  let i = 0;

  let v = n;

  while (v >= 1024 && i < units.length - 1) {

    v /= 1024;

    i++;

  }

  return `${v.toFixed(i === 0 ? 0 : 2)}${units[i]}`;

}

function withTimeout(ms) {

  const controller = new AbortController();

  const t = setTimeout(() => controller.abort(new Error("TIMEOUT")), ms);

  return { controller, stop: () => clearTimeout(t) };

}

// Stream download -> file (low RAM)

async function downloadToFile(url, outPath, signal) {

  const res = await safeFetch(url, {

    method: "GET",

    redirect: "follow",

    signal,

    headers: {

      "user-agent": "Mozilla/5.0",

      accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",

    },

  });

  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const ws = fs.createWriteStream(outPath);

  // WebStream (Node18 fetch)

  if (res.body && typeof res.body.getReader === "function") {

    const reader = res.body.getReader();

    try {

      while (true) {

        const { value, done } = await reader.read();

        if (done) break;

        if (!value) continue;

        ws.write(Buffer.from(value));

      }

      ws.end();

    } catch (e) {

      try { ws.destroy(); } catch {}

      throw e;

    }

  } else if (res.body && typeof res.body.pipe === "function") {

    // Node stream (node-fetch)

    await new Promise((resolve, reject) => {

      res.body.on("error", reject);

      ws.on("error", reject);

      ws.on("finish", resolve);

      res.body.pipe(ws);

    });

  } else {

    throw new Error("Unsupported download stream.");

  }

  const st = fs.existsSync(outPath) ? fs.statSync(outPath) : null;

  if (!st || !st.size) throw new Error("Downloaded file is empty.");

  return st.size;

}

// ffmpeg convert -> mp3 (killable)

function convertToMp3(inPath, outPath, signal) {

  return new Promise((resolve, reject) => {

    const args = [

      "-y",

      "-i", inPath,

      "-vn",

      "-c:a", "libmp3lame",

      "-b:a", "128k",

      "-ar", "44100",

      "-ac", "2",

      outPath,

    ];

    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    let err = "";

    p.stderr.on("data", (d) => {

      // ✅ protect against undefined chunks

      err += (d?.toString?.() ?? String(d ?? ""));

    });

    const kill = () => {

      try { p.kill("SIGKILL"); } catch {}

    };

    // If timeout triggers, kill ffmpeg immediately

    if (signal) {

      if (signal.aborted) kill();

      signal.addEventListener("abort", kill, { once: true });

    }

    p.on("close", (code) => {

      if (signal) {

        try { signal.removeEventListener("abort", kill); } catch {}

      }

      if (code === 0) return resolve(true);

      reject(new Error(`ffmpeg failed (${code ?? "null"}): ${err.slice(-900)}`));

    });

  });

}

export default {

  name: "yta",

  aliases: ["ytmp3", "youtubeaudio"],

  category: "DOWNLOAD",

  description: "Download YouTube audio (safe timeout + no early delete).",

  async execute(ctx) {

    const { sock, m, from, args, prefix } = ctx;

    const targetUrl = pickUrl(args);

    if (!targetUrl) {

      return sock.sendMessage(from, { text: `Usage: ${prefix}yta <youtube link>` }, { quoted: m });

    }

    // Your API

    const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(targetUrl)}&format=mp3`;

    const tmpDir = ensureTempDir();

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const srcPath = path.join(tmpDir, `${id}.source`);

    const mp3Path = path.join(tmpDir, `${id}.mp3`);

    let srcSize = 0;

    let mp3Size = 0;

    // ✅ INTERNAL timeout (keep it below your index command timeout)

    // If your index is 5min, use ~260s so we can reply before it kills the command.

    const INTERNAL_TIMEOUT_MS = 260_000;

    const { controller, stop } = withTimeout(INTERNAL_TIMEOUT_MS);

    try {

      await sock.sendMessage(from, { text: "⏳ Processing... please wait." }, { quoted: m });

      try { await sock.sendPresenceUpdate?.("composing", from); } catch {}

      // 1) API JSON

      const res = await safeFetch(apiUrl, {

        method: "GET",

        headers: { accept: "application/json" },

        signal: controller.signal,

      });

      if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

      const data = await res.json().catch(() => null);

      if (!data || data.success !== true) throw new Error(data?.message || "Invalid API response");

      const downloadURL = data.downloadURL || data.downloadUrl || data.url || data.link;

      const title = cleanFileName(data.title || "YouTube Audio");

      if (!downloadURL || typeof downloadURL !== "string") {

        throw new Error("No valid downloadURL from API.");

      }

      // 2) Download to disk (low RAM)

      srcSize = await downloadToFile(downloadURL, srcPath, controller.signal);

      // 3) Convert to mp3

      await convertToMp3(srcPath, mp3Path, controller.signal);

      // ✅ Ensure mp3 exists before sending (prevents ENOENT)

      if (!fs.existsSync(mp3Path)) throw new Error("MP3 was not created.");

      mp3Size = fs.statSync(mp3Path).size || 0;

      if (!mp3Size) throw new Error("MP3 created but empty.");

      // 4) Send (use file URL so Baileys reads it itself)

      await sock.sendMessage(

        from,

        {

          audio: { url: mp3Path },

          mimetype: "audio/mpeg",

          ptt: false,

          fileName: `${title}.mp3`,

          caption: `✅ ${data.title || title}`,

        },

        { quoted: m }

      );

      return;

    } catch (e) {

      const msg = String(e?.message ?? e ?? "Unknown error");

      const sizeLine = `📦 Size: source: ${formatBytes(srcSize)} | mp3: ${formatBytes(mp3Size)}`;

      if (msg.includes("TIMEOUT") || controller.signal.aborted) {

        return sock.sendMessage(

          from,

          { text: `❌ download unsuccessful\nReason: timeout\n${sizeLine}` },

          { quoted: m }

        );

      }

      // Clean error message (avoid crashing on undefined.toString anywhere)

      return sock.sendMessage(

        from,

        { text: `❌ download unsuccessful\nReason: ${msg}\n${sizeLine}` },

        { quoted: m }

      );

    } finally {

      stop();

      try { await sock.sendPresenceUpdate?.("paused", from); } catch {}

      // ✅ delete ONLY here (prevents early delete ENOENT)

      try { fs.existsSync(srcPath) && fs.unlinkSync(srcPath); } catch {}

      try { fs.existsSync(mp3Path) && fs.unlinkSync(mp3Path); } catch {}

      // Optional: clear old temp (safe)

      try {

        const now = Date.now();

        for (const f of fs.readdirSync(tmpDir)) {

          const p = path.join(tmpDir, f);

          try {

            const st = fs.statSync(p);

            if (now - st.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(p);

          } catch {}

        }

      } catch {}

    }

  },

};