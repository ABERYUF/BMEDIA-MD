// BMEDIA-YTDL — stable backend matching the known-working yts.js route.
// Keeps EXACT route names:
//   GET  /youtube/search?q=
//   POST /youtube/audio
//   POST /youtube/video
//
// Search returns JSON.
// Audio/video return the ACTUAL finished media binary, not a googlevideo URL.

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
const DOWNLOAD_DIR = path.join(ROOT, "downloads");

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const supplied = String(req.headers["x-api-key"] || "").trim();

  if (!API_KEY) {
    return res.status(503).json({
      status: false,
      error: "API_KEY is not loaded.",
    });
  }

  if (supplied !== API_KEY) {
    return res.status(401).json({
      status: false,
      error: "Unauthorized.",
    });
  }

  next();
});

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, {
      cwd: ROOT,
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
  await fsp.access(COOKIES_FILE).catch(() => {
    throw new Error("cookies.txt is missing.");
  });
}

function extractYouTubeUrl(value = "") {
  const text = String(value || "").trim();

  return text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0] || "";
}

function cleanTitle(value = "", fallback = "YouTube Media") {
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

async function makeJobDir() {
  const dir = path.join(DOWNLOAD_DIR, crypto.randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function removeJobDir(dir) {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function findFile(dir, ext) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  const file = entries.find(entry =>
    entry.isFile() &&
    entry.name.toLowerCase().endsWith(ext.toLowerCase()) &&
    !entry.name.endsWith(".part")
  );

  return file ? path.join(dir, file.name) : "";
}

app.get("/health", (req, res) => {
  res.json({
    status: true,
    service: "BMEDIA-YTDL",
    version: "stable-working-yts",
    apiKeyLoaded: Boolean(API_KEY),
    cookiesPresent: fs.existsSync(COOKIES_FILE),
  });
});

app.get("/youtube/search", async (req, res) => {
  const q = String(req.query?.q || "").trim();

  if (!q) {
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
      `ytsearch8:${q}`,
    ]);

    const videos = String(r.stdout || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map(item => ({
        title: cleanTitle(item.title, "Untitled"),
        url:
          String(item.webpage_url || "") ||
          (item.id ? `https://www.youtube.com/watch?v=${item.id}` : ""),
        thumbnail: String(item.thumbnail || ""),
        duration: item.duration_string || (
          Number.isFinite(Number(item.duration))
            ? (() => {
                const total = Number(item.duration);
                const s = Math.floor(total % 60);
                const m = Math.floor((total / 60) % 60);
                const h = Math.floor(total / 3600);
                return h > 0
                  ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
                  : `${m}:${String(s).padStart(2,"0")}`;
              })()
            : ""
        ),
        views: item.view_count == null ? null : Number(item.view_count),
        uploaded: String(item.upload_date || ""),
        author: {
          name: String(item.channel || item.uploader || item.creator || ""),
        },
      }))
      .filter(item => item.url);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      query: q,
      results: { videos },
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "YouTube search failed.",
    });
  }
});

app.post("/youtube/audio", async (req, res) => {
  const raw = String(
    req.body?.input ||
    req.body?.url ||
    req.body?.query ||
    ""
  ).trim();

  if (!raw) {
    return res.status(400).json({
      status: false,
      error: "A YouTube URL or search query is required.",
    });
  }

  const url = extractYouTubeUrl(raw);
  const target = url ? url : `ytsearch1:${raw}`;

  let jobDir = "";

  try {
    const info = await getInfo(target);
    const title = cleanTitle(info.title, "YouTube Audio");

    jobDir = await makeJobDir();
    const outputTemplate = path.join(jobDir, "%(title).180B.%(ext)s");

    await runYtDlp([
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", outputTemplate,
      target,
    ]);

    const filePath = await findFile(jobDir, ".mp3");

    if (!filePath) {
      throw new Error("MP3 output was not found.");
    }

    res.setHeader("x-bmedia-title", encodeURIComponent(title));

    return res.download(
      filePath,
      `${title}.mp3`,
      async () => {
        await removeJobDir(jobDir);
      }
    );
  } catch (error) {
    await removeJobDir(jobDir);

    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        error: error?.message || "Audio download failed.",
      });
    }
  }
});

app.post("/youtube/video", async (req, res) => {
  const raw = String(req.body?.url || req.body?.input || "").trim();
  const url = extractYouTubeUrl(raw);

  if (!url) {
    return res.status(400).json({
      status: false,
      error: "A valid YouTube URL is required.",
    });
  }

  let jobDir = "";

  try {
    const info = await getInfo(url);
    const title = cleanTitle(info.title, "YouTube Video");

    jobDir = await makeJobDir();
    const outputTemplate = path.join(jobDir, "%(title).180B.%(ext)s");

    await runYtDlp([
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-f",
      "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      url,
    ]);

    const filePath = await findFile(jobDir, ".mp4");

    if (!filePath) {
      throw new Error("MP4 output was not found.");
    }

    res.setHeader("x-bmedia-title", encodeURIComponent(title));

    return res.download(
      filePath,
      `${title}.mp4`,
      async () => {
        await removeJobDir(jobDir);
      }
    );
  } catch (error) {
    await removeJobDir(jobDir);

    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        error: error?.message || "Video download failed.",
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BMEDIA-YTDL stable backend running on port ${PORT}`);
});
