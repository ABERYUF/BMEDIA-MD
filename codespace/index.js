// BMEDIA-YTDL V6.2.0 — media delivery fix
// IMPORTANT: /youtube/search is kept unchanged in route/shape for the working YTS command.
//
// Media flow:
// 1. /youtube/video or /youtube/audio prepares and validates the media on Codespace.
// 2. API returns JSON with real title + a temporary BMEDIA /media/<token> URL.
// 3. Main bot downloads that BMEDIA media URL to disk.
// 4. Main bot sends the local validated file to WhatsApp.
//
// This avoids:
// - cross-IP googlevideo URLs
// - binary streaming directly inside the API POST response
// - random filenames becoming captions
// - unsupported codecs reaching WhatsApp

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
const MEDIA_DIR = path.join(ROOT, "media_cache");
const MEDIA_TTL_MS = 30 * 60 * 1000;

await fsp.mkdir(MEDIA_DIR, { recursive: true });

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

function suppliedKey(req) {
  return String(req.headers["x-api-key"] || "").trim();
}

app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/media/")) return next();

  if (!API_KEY) {
    return res.status(503).json({
      status: false,
      error: "API_KEY is not loaded.",
    });
  }

  if (suppliedKey(req) !== API_KEY) {
    return res.status(401).json({
      status: false,
      error: "Unauthorized.",
    });
  }

  next();
});

function run(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
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
          new Error(
            (stderr || stdout || `${cmd} exited with code ${code}`).trim()
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

  const lines = raw.split(/\r?\n/).map(v => v.trim()).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  return null;
}

async function getInfo(target) {
  await ensureRuntime();

  const r = await run("yt-dlp", [
    "--js-runtimes", "node",
    "--cookies", COOKIES_FILE,
    "--no-playlist",
    "--no-warnings",
    "-J",
    target,
  ]);

  const info = parseJson(r.stdout);

  if (!info) throw new Error("Could not read YouTube metadata.");

  return info;
}

async function ffprobe(filePath) {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type,codec_name",
    "-of", "json",
    filePath,
  ]);

  const data = parseJson(r.stdout);

  if (!data) throw new Error("ffprobe could not validate media.");

  const duration = Number(data?.format?.duration || 0);
  const size = Number(data?.format?.size || 0);

  return {
    duration,
    size,
    streams: Array.isArray(data.streams) ? data.streams : [],
  };
}

function publicBase(req) {
  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    req.protocol ||
    "https";

  const host =
    String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() ||
    req.get("host");

  return `${proto}://${host}`;
}

async function cleanupExpiredMedia() {
  const now = Date.now();
  const entries = await fsp.readdir(MEDIA_DIR, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const p = path.join(MEDIA_DIR, entry.name);

    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > MEDIA_TTL_MS) {
        await fsp.rm(p, { force: true });
      }
    } catch {}
  }
}

setInterval(() => {
  cleanupExpiredMedia().catch(() => {});
}, 5 * 60 * 1000).unref?.();

async function newestMatchingFile(dir, predicate) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);

    if (predicate && !predicate(e.name)) continue;

    try {
      const st = await fsp.stat(p);
      files.push({ p, mtime: st.mtimeMs });
    } catch {}
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.p || "";
}

async function prepareVideo(url, title) {
  const workDir = path.join(MEDIA_DIR, `job-${crypto.randomUUID()}`);
  await fsp.mkdir(workDir, { recursive: true });

  const rawTemplate = path.join(workDir, "source.%(ext)s");
  const finalPath = path.join(MEDIA_DIR, `${crypto.randomBytes(16).toString("hex")}.mp4`);

  try {
    await run("yt-dlp", [
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-f",
      "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
      "--merge-output-format", "mp4",
      "-o", rawTemplate,
      url,
    ]);

    const source = await newestMatchingFile(
      workDir,
      name => !name.endsWith(".part")
    );

    if (!source) throw new Error("Downloaded video source was not found.");

    const probe = await ffprobe(source);
    if (probe.duration <= 0 || probe.size < 5000) {
      throw new Error("Downloaded video source is invalid.");
    }

    const videoCodec = probe.streams.find(s => s.codec_type === "video")?.codec_name || "";
    const audioCodec = probe.streams.find(s => s.codec_type === "audio")?.codec_name || "";

    const compatible =
      videoCodec === "h264" &&
      (audioCodec === "aac" || audioCodec === "mp3");

    if (compatible) {
      await run("ffmpeg", [
        "-y",
        "-i", source,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        finalPath,
      ]);
    } else {
      await run("ffmpeg", [
        "-y",
        "-i", source,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        finalPath,
      ]);
    }

    const finalProbe = await ffprobe(finalPath);

    if (finalProbe.duration <= 0 || finalProbe.size < 5000) {
      throw new Error("Final WhatsApp video is invalid.");
    }

    return {
      path: finalPath,
      title,
      duration: finalProbe.duration,
      size: finalProbe.size,
      mimetype: "video/mp4",
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareAudio(target, title) {
  const workDir = path.join(MEDIA_DIR, `job-${crypto.randomUUID()}`);
  await fsp.mkdir(workDir, { recursive: true });

  const rawTemplate = path.join(workDir, "source.%(ext)s");
  const finalPath = path.join(MEDIA_DIR, `${crypto.randomBytes(16).toString("hex")}.mp3`);

  try {
    await run("yt-dlp", [
      "--js-runtimes", "node",
      "--cookies", COOKIES_FILE,
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "-f", "bestaudio/best",
      "-o", rawTemplate,
      target,
    ]);

    const source = await newestMatchingFile(
      workDir,
      name => !name.endsWith(".part")
    );

    if (!source) throw new Error("Downloaded audio source was not found.");

    const sourceProbe = await ffprobe(source);

    if (sourceProbe.duration <= 0 || sourceProbe.size < 1000) {
      throw new Error("Downloaded audio source is invalid.");
    }

    await run("ffmpeg", [
      "-y",
      "-i", source,
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      finalPath,
    ]);

    const finalProbe = await ffprobe(finalPath);

    if (finalProbe.duration <= 0 || finalProbe.size < 1000) {
      throw new Error("Final WhatsApp audio is invalid.");
    }

    return {
      path: finalPath,
      title,
      duration: finalProbe.duration,
      size: finalProbe.size,
      mimetype: "audio/mpeg",
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function tokenFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

app.get("/health", (req, res) => {
  res.json({
    status: true,
    service: "BMEDIA-YTDL",
    version: "6.2.0",
    apiKeyLoaded: Boolean(API_KEY),
    cookiesPresent: fs.existsSync(COOKIES_FILE),
  });
});

// KEEP THIS ROUTE FOR THE USER'S WORKING YTS COMMAND.
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

    const r = await run("yt-dlp", [
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
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean)
      .map(item => {
        const seconds = Number(item.duration || 0);
        const s = Math.floor(seconds % 60);
        const m = Math.floor((seconds / 60) % 60);
        const h = Math.floor(seconds / 3600);

        const duration = seconds > 0
          ? (
              h > 0
                ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
                : `${m}:${String(s).padStart(2, "0")}`
            )
          : "";

        return {
          title: cleanTitle(item.title, "Untitled"),
          url:
            String(item.webpage_url || "") ||
            (item.id ? `https://www.youtube.com/watch?v=${item.id}` : ""),
          thumbnail: String(item.thumbnail || ""),
          duration,
          views: item.view_count == null ? null : Number(item.view_count),
          uploaded: String(item.upload_date || ""),
          author: {
            name: String(item.channel || item.uploader || item.creator || ""),
          },
        };
      })
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

app.post("/youtube/video", async (req, res) => {
  const raw = String(req.body?.url || req.body?.input || "").trim();
  const url = extractYouTubeUrl(raw);

  if (!url) {
    return res.status(400).json({
      status: false,
      error: "A valid YouTube URL is required.",
    });
  }

  try {
    const info = await getInfo(url);
    const title = cleanTitle(info.title, "YouTube Video");
    const media = await prepareVideo(url, title);
    const token = tokenFromPath(media.path);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      title,
      mimetype: media.mimetype,
      duration: media.duration,
      size: media.size,
      mediaUrl: `${publicBase(req)}/media/${token}.mp4`,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Video download failed.",
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

  try {
    const info = await getInfo(target);
    const title = cleanTitle(info.title, "YouTube Audio");
    const media = await prepareAudio(target, title);
    const token = tokenFromPath(media.path);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      title,
      mimetype: media.mimetype,
      duration: media.duration,
      size: media.size,
      mediaUrl: `${publicBase(req)}/media/${token}.mp3`,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Audio download failed.",
    });
  }
});

app.get("/media/:file", async (req, res) => {
  const file = String(req.params.file || "").trim();

  if (!/^[a-f0-9]{32}\.(mp4|mp3)$/i.test(file)) {
    return res.status(400).send("Invalid media token.");
  }

  const filePath = path.join(MEDIA_DIR, file);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Media expired or not found.");
  }

  const ext = path.extname(file).toLowerCase();
  const type = ext === ".mp4" ? "video/mp4" : "audio/mpeg";

  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BMEDIA-YTDL V6.2.0 running on port ${PORT}`);
});
