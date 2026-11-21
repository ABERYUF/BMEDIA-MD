// BMEDIA-YTDL V6.1.0 STABLE
// One unified API route for YTV, YTA and YTS.
// Also keeps old route aliases so cached/older commands do not 404.
//
// Required:
//   API_KEY
//   cookies.txt
//   yt-dlp
//   ffmpeg
//
// Main route:
//   POST /api/youtube
//   body:
//     { "action": "video", "input": "<youtube url>" }
//     { "action": "audio", "input": "<youtube url or search text>" }
//     { "action": "search", "input": "<query>" }
//
// Compatibility aliases:
//   POST /youtube/video
//   POST /youtube/audio
//   GET  /youtube/search?q=
//   POST /api/yta
//   POST /api/yts

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || "").trim();

const ROOT = process.cwd();
const COOKIES_FILE = path.join(ROOT, "cookies.txt");
const WORK_DIR = path.join(ROOT, "downloads");

await fsp.mkdir(WORK_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

function getKey(req) {
  const x = String(req.headers["x-api-key"] || "").trim();
  if (x) return x;

  const auth = String(req.headers.authorization || "").trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  if (!API_KEY) {
    return res.status(503).json({
      status: false,
      error: "API_KEY is not loaded in the Codespace.",
    });
  }

  if (getKey(req) !== API_KEY) {
    return res.status(401).json({
      status: false,
      error: "Unauthorized.",
    });
  }

  next();
});

function runYtDlp(args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);

    p.on("close", code => {
      if (code !== 0) {
        return reject(
          new Error((stderr || stdout || `yt-dlp exited with ${code}`).trim())
        );
      }

      resolve({ stdout, stderr });
    });
  });
}

async function ensureRuntime() {
  await fsp.access(COOKIES_FILE).catch(() => {
    throw new Error("cookies.txt is missing.");
  });
}

function extractYouTubeUrl(value = "") {
  const text = String(value || "").trim();
  const m = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );
  return m?.[0] || "";
}

function sanitizeTitle(value = "", fallback = "YouTube Media") {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || fallback;
}

function parseJson(text = "") {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  return null;
}

async function getInfo(target) {
  await ensureRuntime();

  const r = await runYtDlp([
    "--js-runtimes", "node",
    "--cookies", COOKIES_FILE,
    "--no-playlist",
    "--no-warnings",
    "-J",
    target,
  ]);

  const info = parseJson(r.stdout);

  if (!info) {
    throw new Error("Could not read YouTube metadata.");
  }

  return info;
}

function normalizedMeta(info = {}) {
  return {
    videoId: String(info.id || ""),
    title: sanitizeTitle(info.title, "YouTube Media"),
    thumbnail: String(info.thumbnail || ""),
    duration: Number(info.duration || 0) || 0,
    uploader: String(info.channel || info.uploader || info.creator || ""),
    views: info.view_count == null ? null : Number(info.view_count),
    url: String(info.webpage_url || ""),
  };
}

async function makeJob() {
  const dir = path.join(WORK_DIR, crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function removeJob(dir) {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function firstFile(dir, ext = "") {
  const items = await fsp.readdir(dir, { withFileTypes: true });

  const files = items
    .filter(x => x.isFile())
    .map(x => x.name)
    .filter(x => !x.endsWith(".part"));

  if (ext) {
    const hit = files.find(x => x.toLowerCase().endsWith(ext.toLowerCase()));
    if (hit) return path.join(dir, hit);
  }

  return files[0] ? path.join(dir, files[0]) : "";
}

async function sendMediaFile(res, filePath, jobDir, title, mimetype) {
  const safeTitle = sanitizeTitle(title);
  const ext = path.extname(filePath) || (mimetype === "audio/mpeg" ? ".mp3" : ".mp4");
  const fileName = `${safeTitle}${ext}`;

  res.setHeader("x-bmedia-title", encodeURIComponent(safeTitle));
  res.setHeader("x-bmedia-filename", encodeURIComponent(fileName));
  res.setHeader("content-type", mimetype);

  res.download(filePath, fileName, async () => {
    await removeJob(jobDir);
  });
}

async function handleVideo(req, res, rawInput) {
  const url = extractYouTubeUrl(rawInput);

  if (!url) {
    return res.status(400).json({
      status: false,
      error: "A valid YouTube URL is required.",
    });
  }

  let jobDir = "";

  try {
    await ensureRuntime();

    const info = await getInfo(url);
    const meta = normalizedMeta(info);

    jobDir = await makeJob();
    const outTemplate = path.join(jobDir, "%(title).180B.%(ext)s");

    await runYtDlp([
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-f", "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
      "--merge-output-format", "mp4",
      "-o", outTemplate,
      url,
    ]);

    const filePath = await firstFile(jobDir, ".mp4");

    if (!filePath) {
      throw new Error("Video finished but MP4 output was not found.");
    }

    return sendMediaFile(
      res,
      filePath,
      jobDir,
      meta.title,
      "video/mp4"
    );
  } catch (error) {
    await removeJob(jobDir);

    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        error: error?.message || "Video download failed.",
      });
    }
  }
}

async function handleAudio(req, res, rawInput) {
  let input = String(rawInput || "").trim();

  if (!input) {
    return res.status(400).json({
      status: false,
      error: "A YouTube URL or search query is required.",
    });
  }

  const url = extractYouTubeUrl(input);

  input = url || input
    .replace(/^[.!/#]\s*(?:yta|ytmp3|youtubeaudio|play|song|ytv|ytmp4)\s+/i, "")
    .trim();

  const target = url ? url : `ytsearch1:${input}`;

  let jobDir = "";

  try {
    await ensureRuntime();

    const info = await getInfo(target);
    const meta = normalizedMeta(info);

    jobDir = await makeJob();
    const outTemplate = path.join(jobDir, "%(title).180B.%(ext)s");

    await runYtDlp([
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", outTemplate,
      target,
    ]);

    const filePath = await firstFile(jobDir, ".mp3");

    if (!filePath) {
      throw new Error("Audio finished but MP3 output was not found.");
    }

    return sendMediaFile(
      res,
      filePath,
      jobDir,
      meta.title,
      "audio/mpeg"
    );
  } catch (error) {
    await removeJob(jobDir);

    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        error: error?.message || "Audio download failed.",
      });
    }
  }
}

async function handleSearch(req, res, rawQuery) {
  const query = String(rawQuery || "").trim();

  if (!query) {
    return res.status(400).json({
      status: false,
      error: "Search query is required.",
    });
  }

  try {
    await ensureRuntime();

    const r = await runYtDlp([
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--skip-download",
      "--no-warnings",
      "--dump-json",
      `ytsearch8:${query}`,
    ]);

    const videos = String(r.stdout || "")
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean)
      .map(item => ({
        title: sanitizeTitle(item.title, "Untitled"),
        url:
          String(item.webpage_url || "") ||
          (item.id ? `https://www.youtube.com/watch?v=${item.id}` : ""),
        thumbnail: String(item.thumbnail || ""),
        duration: Number(item.duration || 0) || 0,
        views: item.view_count == null ? null : Number(item.view_count),
        uploaded: String(item.upload_date || ""),
        author: {
          name: String(item.channel || item.uploader || item.creator || ""),
        },
      }))
      .filter(x => x.url);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      query,
      results: { videos },
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "YouTube search failed.",
    });
  }
}

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------

app.get("/health", async (req, res) => {
  let ytDlpAvailable = false;

  try {
    const r = await runYtDlp(["--version"]);
    ytDlpAvailable = Boolean(r.stdout.trim());
  } catch {}

  res.json({
    status: true,
    service: "BMEDIA-YTDL",
    version: "6.1.0",
    apiKeyLoaded: Boolean(API_KEY),
    cookiesPresent: fs.existsSync(COOKIES_FILE),
    ytDlpAvailable,
  });
});

// -----------------------------------------------------------------------------
// ONE UNIFIED ROUTE
// -----------------------------------------------------------------------------

app.post("/api/youtube", async (req, res) => {
  const action = String(req.body?.action || "").trim().toLowerCase();
  const input = String(
    req.body?.input ||
    req.body?.url ||
    req.body?.query ||
    ""
  ).trim();

  if (action === "video") return handleVideo(req, res, input);
  if (action === "audio") return handleAudio(req, res, input);
  if (action === "search") return handleSearch(req, res, input);

  return res.status(400).json({
    status: false,
    error: "action must be video, audio, or search.",
  });
});

// -----------------------------------------------------------------------------
// COMPATIBILITY ROUTES — old/current commands will not 404
// -----------------------------------------------------------------------------

app.post("/youtube/video", (req, res) =>
  handleVideo(req, res, req.body?.url || req.body?.input || "")
);

app.post("/youtube/audio", (req, res) =>
  handleAudio(req, res, req.body?.input || req.body?.url || req.body?.query || "")
);

app.get("/youtube/search", (req, res) =>
  handleSearch(req, res, req.query?.q || "")
);

app.post("/api/yta", (req, res) =>
  handleAudio(req, res, req.body?.input || req.body?.url || req.body?.query || "")
);

app.post("/api/yts", (req, res) =>
  handleSearch(req, res, req.body?.query || req.body?.q || "")
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BMEDIA-YTDL V6.1.0 running on port ${PORT}`);
});
