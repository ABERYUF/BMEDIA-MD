// BMEDIA-YTDL V6.0.0
// Clean rebuild for GitHub Codespaces.
// Node.js ESM.
//
// Required env/secrets:
//   API_KEY
//
// Optional:
//   PORT=3000
//   MEDIA_TTL_MINUTES=30
//
// Required runtime files:
//   cookies.txt
//
// Required binaries:
//   yt-dlp
//   ffmpeg
//
// Endpoints:
//   GET  /health
//   GET  /youtube/info?url=...
//   GET  /youtube/search?q=...
//   POST /youtube/video   { url }
//   POST /youtube/audio   { input }
//   GET  /media/:token
//
// Design:
// - Metadata/search are JSON only.
// - Video prefers a direct signed YouTube media URL.
// - If YouTube has no muxed video+audio stream, backend downloads+merges once
//   and exposes the result through /media/:token.
// - Audio prefers a direct M4A/AAC-style audio URL.
// - If unavailable, backend converts to MP3 and exposes /media/:token.
// - Real YouTube title is carried in JSON; random temp IDs never become captions.

import express from "express";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || "").trim();
const MEDIA_TTL_MINUTES = Math.max(
  5,
  Number(process.env.MEDIA_TTL_MINUTES || 30)
);

const ROOT = process.cwd();
const COOKIES_FILE = path.join(ROOT, "cookies.txt");
const CACHE_DIR = path.join(ROOT, "media_cache");

await fsp.mkdir(CACHE_DIR, { recursive: true });

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// -----------------------------------------------------------------------------
// AUTH
// -----------------------------------------------------------------------------

function suppliedApiKey(req) {
  const headerKey = String(req.headers["x-api-key"] || "").trim();
  if (headerKey) return headerKey;

  const auth = String(req.headers.authorization || "").trim();
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function authMiddleware(req, res, next) {
  if (req.path === "/health" || req.path.startsWith("/media/")) {
    return next();
  }

  if (!API_KEY) {
    return res.status(503).json({
      status: false,
      error:
        "API_KEY is not loaded in this Codespace. Load the Codespaces secret and restart the server.",
    });
  }

  const supplied = suppliedApiKey(req);

  if (!supplied || supplied !== API_KEY) {
    return res.status(401).json({
      status: false,
      error:
        "Unauthorized: the main bot YTDL_API_KEY does not match this Codespace API_KEY.",
    });
  }

  next();
}

app.use(authMiddleware);

// -----------------------------------------------------------------------------
// GENERIC HELPERS
// -----------------------------------------------------------------------------

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        const message = (stderr || stdout || `${cmd} exited with code ${code}`).trim();
        return reject(new Error(message));
      }

      resolve({ stdout, stderr });
    });
  });
}

async function ensureRuntime() {
  try {
    await fsp.access(COOKIES_FILE);
  } catch {
    throw new Error("cookies.txt is missing.");
  }
}

function extractYouTubeUrl(value = "") {
  const text = String(value || "").trim();

  const match = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  return match?.[0] || "";
}

function isYouTubeUrl(value = "") {
  const url = extractYouTubeUrl(value);
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    return (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be"
    );
  } catch {
    return false;
  }
}

function sanitizeTitle(value = "", fallback = "YouTube Media") {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || fallback;
}

function parseJsonFromOutput(text = "") {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  return null;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);

  if (!Number.isFinite(total) || total < 0) return "";

  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function publicBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();

  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");

  return `${protocol}://${host}`;
}

async function cleanupExpiredMedia() {
  const now = Date.now();
  const ttlMs = MEDIA_TTL_MINUTES * 60 * 1000;

  const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = path.join(CACHE_DIR, entry.name);

    try {
      const stat = await fsp.stat(filePath);

      if (now - stat.mtimeMs > ttlMs) {
        await fsp.rm(filePath, { force: true });
      }
    } catch {}
  }
}

setInterval(() => {
  cleanupExpiredMedia().catch(() => {});
}, 5 * 60 * 1000).unref?.();

// -----------------------------------------------------------------------------
// YT-DLP METADATA
// -----------------------------------------------------------------------------

async function getInfo(urlOrSearch) {
  await ensureRuntime();

  const result = await run("yt-dlp", [
    "--js-runtimes",
    "node",
    "--cookies",
    COOKIES_FILE,
    "--no-playlist",
    "--no-warnings",
    "-J",
    urlOrSearch,
  ]);

  const info = parseJsonFromOutput(result.stdout);

  if (!info) {
    throw new Error("Could not parse YouTube metadata.");
  }

  return info;
}

function normalizeInfo(info = {}) {
  return {
    videoId: String(info.id || ""),
    title: sanitizeTitle(info.title, "YouTube Video"),
    durationSeconds: Number(info.duration || 0) || 0,
    duration: formatDuration(info.duration),
    thumbnail: String(info.thumbnail || ""),
    uploader: String(info.channel || info.uploader || info.creator || ""),
    views:
      info.view_count == null
        ? null
        : Number(info.view_count),
    webpageUrl: String(info.webpage_url || ""),
  };
}

function chooseMuxedVideo(info = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];

  const candidates = formats.filter((f) => {
    const hasVideo = f?.vcodec && f.vcodec !== "none";
    const hasAudio = f?.acodec && f.acodec !== "none";
    const hasUrl = typeof f?.url === "string" && /^https?:\/\//i.test(f.url);

    return hasVideo && hasAudio && hasUrl;
  });

  // Prefer MP4 <= 720p because it is much more WhatsApp-friendly.
  candidates.sort((a, b) => {
    const score = (f) => {
      const ext = String(f.ext || "").toLowerCase();
      const mp4Bonus = ext === "mp4" ? 1_000_000 : 0;
      const h = Number(f.height || 0);
      const under720Bonus = h <= 720 ? 500_000 : 0;
      const heightScore = Math.min(h, 720) * 100;
      const bitrate = Number(f.tbr || 0);

      return mp4Bonus + under720Bonus + heightScore + bitrate;
    };

    return score(b) - score(a);
  });

  return candidates[0] || null;
}

function chooseAudio(info = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];

  const candidates = formats.filter((f) => {
    const hasAudio = f?.acodec && f.acodec !== "none";
    const noVideo = !f?.vcodec || f.vcodec === "none";
    const hasUrl = typeof f?.url === "string" && /^https?:\/\//i.test(f.url);

    return hasAudio && noVideo && hasUrl;
  });

  candidates.sort((a, b) => {
    const score = (f) => {
      const ext = String(f.ext || "").toLowerCase();
      const codec = String(f.acodec || "").toLowerCase();

      const m4aBonus =
        ext === "m4a" || codec.includes("mp4a")
          ? 1_000_000
          : 0;

      return m4aBonus + Number(f.abr || f.tbr || 0);
    };

    return score(b) - score(a);
  });

  return candidates[0] || null;
}

function formatRecord(format = {}) {
  return {
    formatId: String(format.format_id || ""),
    quality:
      String(format.format_note || "") ||
      (format.height ? `${format.height}p` : ""),
    ext: String(format.ext || ""),
    mimetype: String(format.ext || "").toLowerCase() === "mp4"
      ? "video/mp4"
      : "",
    width: Number(format.width || 0) || null,
    height: Number(format.height || 0) || null,
    fps: Number(format.fps || 0) || null,
    bitrate: Number(format.tbr || 0) || null,
    url: String(format.url || ""),
  };
}

// -----------------------------------------------------------------------------
// FALLBACK MEDIA CREATION
// -----------------------------------------------------------------------------

async function createVideoFallback(url, title) {
  const token = crypto.randomBytes(16).toString("hex");
  const outputPath = path.join(CACHE_DIR, `${token}.mp4`);

  await run("yt-dlp", [
    "--js-runtimes",
    "node",
    "--cookies",
    COOKIES_FILE,
    "--no-playlist",
    "--no-warnings",
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    url,
  ]);

  const stat = await fsp.stat(outputPath);

  if (!stat.size) {
    throw new Error("Merged video file is empty.");
  }

  return {
    token,
    filePath: outputPath,
    fileName: `${sanitizeTitle(title, "YouTube Video")}.mp4`,
    mimetype: "video/mp4",
    size: stat.size,
  };
}

async function createAudioFallback(urlOrSearch, title) {
  const token = crypto.randomBytes(16).toString("hex");
  const outputPath = path.join(CACHE_DIR, `${token}.mp3`);

  await run("yt-dlp", [
    "--js-runtimes",
    "node",
    "--cookies",
    COOKIES_FILE,
    "--no-playlist",
    "--no-warnings",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "-o",
    outputPath,
    urlOrSearch,
  ]);

  const stat = await fsp.stat(outputPath);

  if (!stat.size) {
    throw new Error("Converted audio file is empty.");
  }

  return {
    token,
    filePath: outputPath,
    fileName: `${sanitizeTitle(title, "YouTube Audio")}.mp3`,
    mimetype: "audio/mpeg",
    size: stat.size,
  };
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

app.get("/health", async (req, res) => {
  let ytDlpOk = false;

  try {
    const version = await run("yt-dlp", ["--version"]);
    ytDlpOk = Boolean(String(version.stdout || "").trim());
  } catch {}

  res.json({
    status: true,
    service: "BMEDIA-YTDL",
    version: "6.0.0",
    apiKeyLoaded: Boolean(API_KEY),
    cookiesPresent: fs.existsSync(COOKIES_FILE),
    ytDlpAvailable: ytDlpOk,
  });
});

app.get("/youtube/info", async (req, res) => {
  const raw = String(req.query?.url || "").trim();
  const url = extractYouTubeUrl(raw);

  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({
      status: false,
      error: "A valid YouTube URL is required.",
    });
  }

  try {
    const info = await getInfo(url);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      ...normalizeInfo(info),
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Could not read YouTube metadata.",
    });
  }
});


app.post("/api/yts", async (req, res) => {
  const query = String(req.body?.query || req.body?.q || "").trim();

  if (!query) {
    return res.status(400).json({
      status: false,
      error: "Search query is required.",
    });
  }

  try {
    await ensureRuntime();

    const result = await run("yt-dlp", [
      "--js-runtimes",
      "node",
      "--cookies",
      COOKIES_FILE,
      "--skip-download",
      "--no-warnings",
      "--dump-json",
      `ytsearch8:${query}`,
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
      .map((item) => {
        const normalized = normalizeInfo(item);

        return {
          title: normalized.title,
          url:
            normalized.webpageUrl ||
            (normalized.videoId
              ? `https://www.youtube.com/watch?v=${normalized.videoId}`
              : ""),
          thumbnail: normalized.thumbnail,
          duration: normalized.duration,
          views: normalized.views,
          uploaded: String(item.upload_date || ""),
          author: { name: normalized.uploader },
        };
      })
      .filter((item) => item.url);

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
});

app.get("/youtube/search", async (req, res) => {
  const query = String(req.query?.q || "").trim();

  if (!query) {
    return res.status(400).json({
      status: false,
      error: "Search query is required.",
    });
  }

  try {
    await ensureRuntime();

    const result = await run("yt-dlp", [
      "--js-runtimes",
      "node",
      "--cookies",
      COOKIES_FILE,
      "--skip-download",
      "--no-warnings",
      "--dump-json",
      `ytsearch8:${query}`,
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
      .map((item) => {
        const normalized = normalizeInfo(item);

        return {
          title: normalized.title,
          url:
            normalized.webpageUrl ||
            (normalized.videoId
              ? `https://www.youtube.com/watch?v=${normalized.videoId}`
              : ""),
          thumbnail: normalized.thumbnail,
          duration: normalized.duration,
          views: normalized.views,
          uploaded: String(item.upload_date || ""),
          author: {
            name: normalized.uploader,
          },
        };
      })
      .filter((item) => item.url);

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      query,
      results: {
        videos,
      },
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

  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({
      status: false,
      error: "A valid YouTube URL is required.",
    });
  }

  try {
    const info = await getInfo(url);
    const metadata = normalizeInfo(info);
    const direct = chooseMuxedVideo(info);

    if (direct?.url) {
      const format = formatRecord(direct);

      return res.json({
        status: true,
        creator: "BMEDIA-MD",
        ...metadata,
        quality: format.quality,
        downloadUrl: format.url,
        url: format.url,
        mimetype: format.mimetype || "video/mp4",
        engine: "youtube-direct",
        temporary: true,
        video: [format],
      });
    }

    const fallback = await createVideoFallback(url, metadata.title);
    const mediaUrl = `${publicBaseUrl(req)}/media/${fallback.token}`;

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      ...metadata,
      quality: "720p fallback",
      downloadUrl: mediaUrl,
      url: mediaUrl,
      mimetype: fallback.mimetype,
      fileName: fallback.fileName,
      size: fallback.size,
      engine: "bmedia-merge",
      temporary: true,
      expiresInMinutes: MEDIA_TTL_MINUTES,
      video: [
        {
          quality: "720p fallback",
          ext: "mp4",
          url: mediaUrl,
        },
      ],
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Video download failed.",
    });
  }
});


app.post("/api/yta", async (req, res) => {
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

  const extractedUrl = extractYouTubeUrl(raw);
  const cleanedQuery = raw
    .replace(/^[.!/#]\s*(?:yta|ytmp3|youtubeaudio|play|song)\s+/i, "")
    .trim();

  const target = extractedUrl
    ? extractedUrl
    : `ytsearch1:${cleanedQuery}`;

  try {
    const info = await getInfo(target);
    const metadata = normalizeInfo(info);
    const direct = chooseAudio(info);

    if (
      direct?.url &&
      (
        String(direct.ext || "").toLowerCase() === "m4a" ||
        String(direct.acodec || "").toLowerCase().includes("mp4a")
      )
    ) {
      return res.json({
        status: true,
        creator: "BMEDIA-MD",
        ...metadata,
        downloadUrl: direct.url,
        url: direct.url,
        mimetype: "audio/mp4",
        fileName: `${metadata.title}.m4a`,
        engine: "youtube-direct-audio",
        temporary: true,
        audio: {
          formatId: String(direct.format_id || ""),
          ext: String(direct.ext || ""),
          bitrate: Number(direct.abr || direct.tbr || 0) || null,
          url: direct.url,
        },
      });
    }

    const fallback = await createAudioFallback(target, metadata.title);
    const mediaUrl = `${publicBaseUrl(req)}/media/${fallback.token}`;

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      ...metadata,
      downloadUrl: mediaUrl,
      url: mediaUrl,
      mimetype: fallback.mimetype,
      fileName: fallback.fileName,
      size: fallback.size,
      engine: "bmedia-mp3",
      temporary: true,
      expiresInMinutes: MEDIA_TTL_MINUTES,
      audio: { ext: "mp3", url: mediaUrl },
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Audio download failed.",
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

  const extractedUrl = extractYouTubeUrl(raw);

  const target = extractedUrl
    ? extractedUrl
    : `ytsearch1:${raw.replace(/^[.!/#]\s*(?:yta|ytmp3|play|song)\s+/i, "").trim()}`;

  try {
    const info = await getInfo(target);
    const metadata = normalizeInfo(info);
    const direct = chooseAudio(info);

    // Prefer direct M4A/MP4A audio. It is usually WhatsApp-friendly and avoids
    // forcing the Codespace to download+convert every request.
    if (
      direct?.url &&
      (
        String(direct.ext || "").toLowerCase() === "m4a" ||
        String(direct.acodec || "").toLowerCase().includes("mp4a")
      )
    ) {
      return res.json({
        status: true,
        creator: "BMEDIA-MD",
        ...metadata,
        downloadUrl: direct.url,
        url: direct.url,
        mimetype: "audio/mp4",
        fileName: `${metadata.title}.m4a`,
        engine: "youtube-direct-audio",
        temporary: true,
        audio: {
          formatId: String(direct.format_id || ""),
          ext: String(direct.ext || ""),
          bitrate: Number(direct.abr || direct.tbr || 0) || null,
          url: direct.url,
        },
      });
    }

    const fallback = await createAudioFallback(target, metadata.title);
    const mediaUrl = `${publicBaseUrl(req)}/media/${fallback.token}`;

    return res.json({
      status: true,
      creator: "BMEDIA-MD",
      ...metadata,
      downloadUrl: mediaUrl,
      url: mediaUrl,
      mimetype: fallback.mimetype,
      fileName: fallback.fileName,
      size: fallback.size,
      engine: "bmedia-mp3",
      temporary: true,
      expiresInMinutes: MEDIA_TTL_MINUTES,
      audio: {
        ext: "mp3",
        url: mediaUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      error: error?.message || "Audio download failed.",
    });
  }
});

app.get("/media/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();

  if (!/^[a-f0-9]{32}$/i.test(token)) {
    return res.status(400).send("Invalid media token.");
  }

  const candidates = [
    { path: path.join(CACHE_DIR, `${token}.mp4`), type: "video/mp4" },
    { path: path.join(CACHE_DIR, `${token}.mp3`), type: "audio/mpeg" },
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;

    res.type(candidate.type);

    return res.sendFile(candidate.path, {
      headers: {
        "Cache-Control": "private, max-age=300",
      },
    });
  }

  return res.status(404).send("Media expired or not found.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BMEDIA-YTDL V6.0.0 running on port ${PORT}`);
});
