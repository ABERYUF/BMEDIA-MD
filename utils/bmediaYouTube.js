// utils/bmediaYouTube.js
// BMEDIA-MD YouTube helper
// - Uses your BMEDIA-YTDL backend for downloads
// - Uses local yt-search only when a title/query must be resolved
// - Small in-memory search cache to avoid repeated YouTube requests

const DEFAULT_API = "https://bmedia-ytdl.onrender.com";
const SEARCH_TTL_MS = Number(process.env.YT_SEARCH_TTL_MS || 180000);
const API_TIMEOUT_MS = Number(process.env.YT_API_TIMEOUT_MS || 20000);

const searchCache = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

export function safeFileName(name, fallback = "YouTube Media") {
  const out = clean(name)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);

  return out || fallback;
}

export function findYouTubeUrl(input = "") {
  const text = clean(input);
  if (!text) return "";

  const match = text.match(
    /https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?[^ ]*v=|shorts\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}[^\s]*/i
  );

  if (match?.[0]) {
    return match[0].replace(/[),.;!?]+$/, "");
  }

  // Accept a bare 11-char YouTube ID too.
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) {
    return `https://www.youtube.com/watch?v=${text}`;
  }

  return "";
}

function apiBase() {
  return clean(process.env.BMEDIA_YTDL_URL || DEFAULT_API).replace(/\/+$/, "");
}

async function fetchJson(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    if (!response.ok) {
      throw new Error(
        data?.error ||
        data?.message ||
        `BMEDIA API HTTP ${response.status}`
      );
    }

    if (!data || data.status !== true) {
      throw new Error(
        data?.error ||
        data?.message ||
        "Invalid BMEDIA-YTDL response."
      );
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("BMEDIA-YTDL request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let ytSearchLoader = null;

async function getYtSearch() {
  if (!ytSearchLoader) {
    ytSearchLoader = import("yt-search").then((mod) => mod.default || mod);
  }

  return ytSearchLoader;
}

function mapSearchVideo(video) {
  return {
    id: video?.videoId || video?.video_id || "",
    title: clean(video?.title) || "Untitled",
    url:
      clean(video?.url) ||
      (video?.videoId
        ? `https://www.youtube.com/watch?v=${video.videoId}`
        : ""),
    thumbnail:
      clean(video?.thumbnail) ||
      clean(video?.image) ||
      "",
    duration:
      clean(video?.timestamp) ||
      clean(video?.duration?.timestamp) ||
      "",
    seconds:
      Number(video?.seconds || video?.duration?.seconds || 0) || 0,
    views: Number(video?.views || 0) || 0,
    uploaded:
      clean(video?.ago) ||
      clean(video?.uploaded) ||
      "",
    author:
      clean(video?.author?.name) ||
      clean(video?.author) ||
      "",
  };
}

export async function searchYouTube(query, limit = 6) {
  const q = clean(query);
  if (!q) throw new Error("Search query is empty.");

  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.results.slice(0, limit);
  }

  const yts = await getYtSearch();
  const response = await yts(q);

  const results = (response?.videos || [])
    .map(mapSearchVideo)
    .filter((v) => v.url && v.title)
    .slice(0, Math.max(limit, 8));

  if (!results.length) {
    throw new Error("No YouTube results found.");
  }

  searchCache.set(cacheKey, {
    results,
    expiresAt: Date.now() + SEARCH_TTL_MS,
  });

  // Stop unbounded cache growth.
  if (searchCache.size > 100) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }

  return results.slice(0, limit);
}

export async function resolveYouTubeInput(input) {
  const direct = findYouTubeUrl(input);

  if (direct) {
    return {
      url: direct,
      searchResult: null,
    };
  }

  const [first] = await searchYouTube(input, 1);

  if (!first?.url) {
    throw new Error("Could not find a YouTube result.");
  }

  return {
    url: first.url,
    searchResult: first,
  };
}

export async function getVideoDownload(youtubeUrl, quality = 720) {
  const base = apiBase();

  return fetchJson(
    `${base}/youtube/video?url=${encodeURIComponent(youtubeUrl)}&quality=${encodeURIComponent(quality)}`
  );
}

export async function getAudioDownload(youtubeUrl, quality = 128) {
  const base = apiBase();

  return fetchJson(
    `${base}/youtube/audio?url=${encodeURIComponent(youtubeUrl)}&quality=${encodeURIComponent(quality)}`
  );
}

export function formatViews(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n) || n <= 0) return "";

  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  }

  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }

  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }

  return String(n);
}
