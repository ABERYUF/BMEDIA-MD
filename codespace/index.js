// index.js — BMEDIA-YTDL Codespaces backend
// Node.js ESM
//
// Required Codespaces secrets:
//   API_KEY
//   YT_COOKIES_B64 -> restored to cookies.txt by your devcontainer setup
//
// Endpoints:
//   GET  /health
//   GET  /youtube/search?q=...
//   POST /youtube/video { url }
//   POST /youtube/audio { input/url/query }

import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const ROOT = process.cwd();
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const COOKIES_FILE = path.join(ROOT, "cookies.txt");
const API_KEY = String(process.env.API_KEY || "").trim();

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

function suppliedApiKey(req) {
  const direct = String(req.headers["x-api-key"] || "").trim();
  if (direct) return direct;

  const auth = String(req.headers.authorization || "").trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  if (!API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "BMEDIA-YTDL API_KEY is not loaded. Restart the Codespace after loading the secret.",
    });
  }

  const supplied = suppliedApiKey(req);

  if (!supplied || supplied !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized: YTDL_API_KEY does not match the Codespace API_KEY.",
    });
  }

  next();
});

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            (stderr || stdout || `yt-dlp exited with code ${code}`).trim()
          )
        );
      }

      resolve({ stdout, stderr });
    });
  });
}

async function ensureRuntime() {
  try {
    await fsp.access(COOKIES_FILE);
  } catch {
    throw new Error("cookies.txt is missing on the BMEDIA-YTDL server.");
  }
}

function extractYouTubeUrl(value = "") {
  const text = String(value || "").trim();
  const m = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );
  return m?.[0] || "";
}

function isYouTubeUrl(value = "") {
  const found = extractYouTubeUrl(value);
  if (!found) return false;

  try {
    const u = new URL(found);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be"
    );
  } catch {
    return false;
  }
}

function normalizeAudioTarget(value = "") {
  const input = String(value || "").trim();
  const url = extractYouTubeUrl(input);

  if (url) return url;

  // Strip a mistakenly included bot command prefix such as ".yta " or ".ytv "
  // before treating the remaining text as a YouTube search query.
  const cleaned = input.replace(/^[.!/#]\s*(?:yta|ytv|ytmp3|ytmp4|yts|ytsearch)\s+/i, "").trim();

  return cleaned ? `ytsearch1:${cleaned}` : "";
}

async function makeJobDir() {
  const dir = path.join(DOWNLOAD_DIR, crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function removeJobDir(dir) {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function findOutputFile(dir, preferredExt = "") {
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".part"));

  if (!files.length) return null;

  if (preferredExt) {
    const preferred = files.find((name) =>
      name.toLowerCase().endsWith(preferredExt.toLowerCase())
    );

    if (preferred) return path.join(dir, preferred);
  }

  return path.join(dir, files[0]);
}

function safeHeaderTitle(filePath, fallback = "YouTube Media") {
  const base = path.basename(filePath || "");
  const ext = path.extname(base);
  const title = path.basename(base, ext).trim();
  return title || fallback;
}

async function sendFileAndCleanup(res, filePath, jobDir, fallbackName, fallbackTitle) {
  const fileName = path.basename(filePath || "").trim() || fallbackName;
  const title = safeHeaderTitle(filePath, fallbackTitle);

  res.setHeader("x-bmedia-title", encodeURIComponent(title));

  return res.download(filePath, fileName, async () => {
    await removeJobDir(jobDir);
  });
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return "";

  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatUploadDate(value = "") {
  const v = String(value || "").trim();

  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }

  return v;
}

function pickThumbnail(item = {}) {
  if (item.thumbnail) return item.thumbnail;

  const thumbnails = Array.isArray(item.thumbnails)
    ? item.thumbnails
    : [];

  return thumbnails.at(-1)?.url || thumbnails[0]?.url || "";
}

function normalizeSearchItem(item = {}) {
  const id = String(item.id || "").trim();

  const url =
    String(item.webpage_url || "").trim() ||
    (id ? `https://www.youtube.com/watch?v=${id}` : "");

  const author = String(
    item.channel ||
    item.uploader ||
    item.creator ||
    ""
  ).trim();

  return {
    title: String(item.title || "Untitled"),
    url,
    thumbnail: pickThumbnail(item),
    duration:
      String(item.duration_string || "").trim() ||
      formatDuration(item.duration),
    views:
      item.view_count == null
        ? null
        : Number(item.view_count),
    uploaded: formatUploadDate(item.upload_date),
    author: {
      name: author,
    },
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "BMEDIA-YTDL",
    apiKeyLoaded: Boolean(API_KEY),
    cookiesPresent: fs.existsSync(COOKIES_FILE),
  });
});

app.get("/youtube/search", async (req, res) => {
  const q = String(req.query?.q || "").trim();

  if (!q) {
    return res.status(400).json({
      success: false,
      error: "Search query is required.",
    });
  }

  try {
    await ensureRuntime();

    const result = await runYtDlp([
      "--js-runtimes",
      "node",
      "--cookies",
      COOKIES_FILE,
      "--skip-download",
      "--dump-json",
      "--no-warnings",
      `ytsearch8:${q}`,
    ]);

    const videos = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map(normalizeSearchItem)
      .filter((item) => item.url);

    return res.json({
      success: true,
      results: { videos },
    });
  } catch (error) {
    console.error("[SEARCH]", error?.message || error);

    return res.status(500).json({
      success: false,
      error: error?.message || "YouTube search failed.",
    });
  }
});

app.post("/youtube/video", async (req, res) => {
  const raw = String(req.body?.url || req.body?.input || "").trim();
  const url = extractYouTubeUrl(raw);

  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({
      ok: false,
      error: "A valid YouTube URL is required.",
    });
  }

  let jobDir = "";

  try {
    await ensureRuntime();
    jobDir = await makeJobDir();

    const outputTemplate = path.join(
      jobDir,
      "%(title).180B.%(ext)s"
    );

    await runYtDlp([
      "--js-runtimes",
      "node",
      "--cookies",
      COOKIES_FILE,
      "--no-playlist",
      "--no-part",
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      url,
    ]);

    const filePath = await findOutputFile(jobDir, ".mp4");

    if (!filePath) {
      throw new Error("Download completed but the video output was not found.");
    }

    return sendFileAndCleanup(
      res,
      filePath,
      jobDir,
      "YouTube Video.mp4",
      "YouTube Video"
    );
  } catch (error) {
    await removeJobDir(jobDir);

    console.error("[VIDEO]", error?.message || error);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Video download failed.",
      });
    }
  }
});

app.post("/youtube/audio", async (req, res) => {
  const input = String(
    req.body?.input ||
    req.body?.url ||
    req.body?.query ||
    ""
  ).trim();

  const target = normalizeAudioTarget(input);

  if (!target) {
    return res.status(400).json({
      ok: false,
      error: "A YouTube URL or search query is required.",
    });
  }

  let jobDir = "";

  try {
    await ensureRuntime();
    jobDir = await makeJobDir();

    const outputTemplate = path.join(
      jobDir,
      "%(title).180B.%(ext)s"
    );

    await runYtDlp([
      "--js-runtimes",
      "node",
      "--cookies",
      COOKIES_FILE,
      "--no-playlist",
      "--no-part",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-o",
      outputTemplate,
      target,
    ]);

    const filePath = await findOutputFile(jobDir, ".mp3");

    if (!filePath) {
      throw new Error("Audio conversion completed but the MP3 output was not found.");
    }

    return sendFileAndCleanup(
      res,
      filePath,
      jobDir,
      "YouTube Audio.mp3",
      "YouTube Audio"
    );
  } catch (error) {
    await removeJobDir(jobDir);

    console.error("[AUDIO]", error?.message || error);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Audio download failed.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BMEDIA-YTDL running on port ${PORT}`);
});
