// commands/ytv.js (ESM)
// BMEDIA-MD — YouTube video using private BMEDIA-YTDL.
// Same command-object format as the old BMEDIA-MD commands.

import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

const DOWNLOAD_TEMP_DIR = path.join(process.cwd(), "download_temp");
const MIN_VALID_BYTES = 5000;

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function pickUrl(args) {
  const s = (args || []).join(" ").trim();
  const m = s.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );
  return m ? m[0] : "";
}

function cleanFileName(name) {
  return String(name || "YouTube Video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function ensureDownloadTempDir() {
  if (!fs.existsSync(DOWNLOAD_TEMP_DIR)) {
    fs.mkdirSync(DOWNLOAD_TEMP_DIR, { recursive: true });
  }
}

function cleanupDownloadTemp(maxAgeMinutes = 30) {
  ensureDownloadTempDir();
  const now = Date.now();

  for (const f of fs.readdirSync(DOWNLOAD_TEMP_DIR)) {
    const p = path.join(DOWNLOAD_TEMP_DIR, f);

    try {
      const st = fs.statSync(p);

      if (now - st.mtimeMs > maxAgeMinutes * 60 * 1000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }
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

async function downloadVideo(url, outPath) {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  const response = await safeFetch(`${baseUrl}/youtube/video`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const stream = responseBodyToNodeReadable(response.body);
  if (!stream) throw new Error("No video returned by BMEDIA-YTDL.");

  const ws = fs.createWriteStream(outPath);
  let bytes = 0;

  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      bytes += chunk?.length || 0;
    });

    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  if (bytes < MIN_VALID_BYTES) {
    throw new Error("Downloaded video is too small or invalid.");
  }

  return {
    title: cleanFileName(getHeaderTitle(response) || "YouTube Video"),
    contentType: String(response.headers.get("content-type") || "video/mp4"),
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let err = "";

    p.stderr.on("data", (d) => {
      err += d?.toString?.() ?? String(d ?? "");
    });

    p.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-700)}`));
    });
  });
}

async function remuxToMp4(inputPath, outputPath) {
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-movflags", "+faststart",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    outputPath,
  ]);
}

function runDownload(ctx, url) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    ensureDownloadTempDir();
    cleanupDownloadTemp(30);

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const rawPath = path.join(DOWNLOAD_TEMP_DIR, `${id}.mp4`);
    const fixedPath = path.join(DOWNLOAD_TEMP_DIR, `${id}.fixed.mp4`);

    await sock.sendMessage(from, {
      react: { text: "⏳", key: m.key },
    }).catch(() => {});

    try {
      await sock.sendMessage(
        from,
        { text: "⏳ Processing... please wait." },
        { quoted: m }
      );

      const result = await downloadVideo(url, rawPath);

      try {
        await sock.sendMessage(
          from,
          {
            video: { url: rawPath },
            mimetype: result.contentType.startsWith("video/")
              ? result.contentType
              : "video/mp4",
            caption: `✅ ${result.title}`,
          },
          { quoted: m }
        );
      } catch {
        await remuxToMp4(rawPath, fixedPath);

        await sock.sendMessage(
          from,
          {
            video: { url: fixedPath },
            mimetype: "video/mp4",
            caption: `✅ ${result.title}`,
          },
          { quoted: m }
        );
      }

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
      for (const p of [rawPath, fixedPath]) {
        try {
          fs.rmSync(p, { force: true });
        } catch {}
      }

      cleanupDownloadTemp(30);
    }
  }, 250);
}

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video.",

  async execute(ctx) {
    const { sock, m, from, args, prefix } = ctx;
    const url = pickUrl(args);

    if (!url) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}ytv <youtube link>` },
        { quoted: m }
      );
    }

    runDownload(ctx, url);
    return true;
  },
};
