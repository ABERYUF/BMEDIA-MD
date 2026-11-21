// BMEDIA-YTDL Codespaces backend
// Node.js ESM
//
// Codespaces secrets:
//   API_KEY
//   YT_COOKIES_B64  (restored to cookies.txt by devcontainer)
//
// Endpoints:
//   GET  /health
//   POST /youtube/video   { "url": "https://youtube..." }
//   POST /youtube/audio   { "input": "YouTube URL OR search text" }

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

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const suppliedKey = String(req.headers["x-api-key"] || "").trim();

  if (!API_KEY || suppliedKey !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized.",
    });
  }

  next();
});

function isYouTubeUrl(value = "") {
  try {
    const u = new URL(String(value || "").trim());
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

  if (!API_KEY) {
    throw new Error("API_KEY is not configured on the BMEDIA-YTDL server.");
  }
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

async function findOutputFile(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".part"));

  if (!files.length) return null;

  // Prefer final mp4/mp3 outputs.
  const preferred =
    files.find((name) => /\.mp4$/i.test(name)) ||
    files.find((name) => /\.mp3$/i.test(name)) ||
    files[0];

  return path.join(dir, preferred);
}

function safeDownloadName(filePath, fallback) {
  const name = path.basename(filePath || "").trim();
  return name || fallback;
}

async function sendFileAndCleanup(res, filePath, jobDir, fallbackName) {
  const fileName = safeDownloadName(filePath, fallbackName);

  // res.download streams the file instead of loading it into RAM.
  return res.download(filePath, fileName, async () => {
    await removeJobDir(jobDir);
  });
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "BMEDIA-YTDL",
  });
});

app.post("/youtube/video", async (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!isYouTubeUrl(url)) {
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

    const filePath = await findOutputFile(jobDir);

    if (!filePath) {
      throw new Error("Download completed but the video output was not found.");
    }

    return sendFileAndCleanup(
      res,
      filePath,
      jobDir,
      "YouTube Video.mp4"
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

  if (!input) {
    return res.status(400).json({
      ok: false,
      error: "A YouTube URL or search query is required.",
    });
  }

  const target = isYouTubeUrl(input)
    ? input
    : `ytsearch1:${input}`;

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

    const filePath = await findOutputFile(jobDir);

    if (!filePath) {
      throw new Error("Audio conversion completed but the output was not found.");
    }

    return sendFileAndCleanup(
      res,
      filePath,
      jobDir,
      "YouTube Audio.mp3"
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
