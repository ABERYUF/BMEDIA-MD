// commands/ytv.js
// BMEDIA-MD V6 — YouTube video via private BMEDIA-YTDL V6 API.
// Keeps the old BMEDIA-MD command object format.

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

function responseBodyToNodeReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function cleanTitle(name) {
  return String(name || "YouTube Video")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function pickUrl(args = []) {
  const input = args.join(" ").trim();

  const match = input.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  return match?.[0] || "";
}

function apiConfig() {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  return { baseUrl, apiKey };
}

async function readApiResponse(response) {
  const text = await response.text();

  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      `API error: HTTP ${response.status}`
    );
  }

  if (!data || data.status !== true) {
    throw new Error(data?.error || "Invalid BMEDIA-YTDL response.");
  }

  return data;
}

async function getVideoInfo(url) {
  const { baseUrl, apiKey } = apiConfig();

  const response = await safeFetch(`${baseUrl}/youtube/video`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url }),
  });

  return readApiResponse(response);
}

function ensureTempDir() {
  if (!fs.existsSync(DOWNLOAD_TEMP_DIR)) {
    fs.mkdirSync(DOWNLOAD_TEMP_DIR, { recursive: true });
  }
}

async function downloadToFile(url, filePath) {
  const response = await safeFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Video file download failed: HTTP ${response.status}`);
  }

  const stream = responseBodyToNodeReadable(response.body);
  if (!stream) throw new Error("Video response had no body.");

  const ws = fs.createWriteStream(filePath);
  let totalBytes = 0;

  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      totalBytes += chunk?.length || 0;
    });

    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  if (totalBytes < MIN_VALID_BYTES) {
    throw new Error("Downloaded video is too small or invalid.");
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let errorText = "";

    proc.stderr.on("data", (chunk) => {
      errorText += chunk?.toString?.() ?? String(chunk ?? "");
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(
          new Error(
            `ffmpeg failed (${code}): ${errorText.slice(-700)}`
          )
        );
      }
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
    ensureTempDir();

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const rawPath = path.join(DOWNLOAD_TEMP_DIR, `${id}.mp4`);
    const fixedPath = path.join(DOWNLOAD_TEMP_DIR, `${id}.fixed.mp4`);

    await sock.sendMessage(from, {
      react: { text: "⏳", key: m.key },
    }).catch(() => {});

    try {
      const data = await getVideoInfo(url);
      const title = cleanTitle(data.title || "YouTube Video");

      await downloadToFile(
        data.downloadUrl || data.url,
        rawPath
      );

      try {
        await sock.sendMessage(
          from,
          {
            video: { url: rawPath },
            mimetype: data.mimetype || "video/mp4",
            caption: title,
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
            caption: title,
          },
          { quoted: m }
        );
      }

      await sock.sendMessage(from, {
        react: { text: "✅", key: m.key },
      }).catch(() => {});
    } catch (error) {
      await sock.sendMessage(from, {
        react: { text: "❌", key: m.key },
      }).catch(() => {});

      await sock.sendMessage(
        from,
        {
          text:
            `❌ download unsuccessful\n` +
            `Reason: ${error?.message || error}`,
        },
        { quoted: m }
      ).catch(() => {});
    } finally {
      for (const filePath of [rawPath, fixedPath]) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {}
      }
    }
  }, 250);
}

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video.",
  usage: "ytv <YouTube link>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const url = pickUrl(args);

    if (!url) {
      return sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *YOUTUBE VIDEO* 〕\n` +
            `╰◦ Usage: ${prefix}ytv <YouTube link>\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      );
    }

    runDownload(ctx, url);
    return true;
  },
};
