// commands/fb.js
// BMEDIA-MD — Facebook downloader using AHM7xMakki AllDL API
// LOW-RAM BUILD
// - Streams the Facebook video to ./download_temp instead of keeping it in RAM
// - Processes only ONE Facebook download/send at a time
// - Caps download size to protect small Pterodactyl containers
// - No ffmpeg and no extra npm dependencies
// - Deletes temporary files immediately after send/failure

import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const API_BASE = "https://ahm7xmakki.com/api/alldl";
const TEMP_DIR = path.join(process.cwd(), "download_temp");
const TEMP_PREFIX = "bmedia_fb_";
const MIN_VALID_BYTES = 5_000;
const DISK_STOP_PERCENT = 92;
const API_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

// Can be overridden from .env, e.g. FB_MAX_MB=60
const MAX_VIDEO_MB = Math.max(5, Number(process.env.FB_MAX_MB || 70));
const MAX_VIDEO_BYTES = Math.floor(MAX_VIDEO_MB * 1024 * 1024);

// Keep Facebook media work serialized. This is important on low-RAM hosts.
let queueTail = Promise.resolve();
let queueDepth = 0;

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function cleanupOwnTemp(maxAgeMinutes = 30) {
  ensureTempDir();
  const now = Date.now();

  for (const name of fs.readdirSync(TEMP_DIR)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;

    const filePath = path.join(TEMP_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs >= maxAgeMinutes * 60 * 1000) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {}
  }
}

function removeFile(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function getDiskUsagePercent() {
  ensureTempDir();
  if (typeof fs.statfsSync !== "function") return 0;

  try {
    const stat = fs.statfsSync(TEMP_DIR);
    const blocks = Number(stat.blocks || 0);
    const available = Number(stat.bavail ?? stat.bfree ?? 0);
    if (!blocks) return 0;
    return ((blocks - available) / blocks) * 100;
  } catch {
    return 0;
  }
}

function assertDiskSafe() {
  const used = getDiskUsagePercent();
  if (used >= DISK_STOP_PERCENT) {
    cleanupOwnTemp(0);
    throw new Error(
      `Server disk usage is ${used.toFixed(1)}%. Facebook download stopped to protect the bot.`
    );
  }
}

function pickUrl(args = []) {
  const text = args.join(" ").trim();
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function isFacebookUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "fb.com" ||
      host.endsWith(".fb.com") ||
      host === "fb.watch"
    );
  } catch {
    return false;
  }
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";

  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }

  return String(n);
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";

  try {
    let date;

    if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
      const n = Number(value);
      date = new Date(String(Math.trunc(n)).length <= 10 ? n * 1000 : n);
    } else {
      date = new Date(value);
    }

    if (Number.isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return "";
  }
}

function scoreQuality(item = {}) {
  const label = String(
    item?.quality ||
      item?.label ||
      item?.resolution ||
      item?.name ||
      ""
  ).toLowerCase();

  const height = Number(label.match(/(\d{3,4})\s*p?/)?.[1] || 0);
  if (height) return height;
  if (label.includes("full hd") || label.includes("fhd")) return 1080;
  if (label.includes("hd")) return 720;
  if (label.includes("sd")) return 480;
  return 0;
}

function chooseVideo(mediaInfo = {}) {
  const qualities = Array.isArray(mediaInfo?.qualities)
    ? mediaInfo.qualities
    : [];

  const valid = qualities
    .map((item) => ({
      item,
      url: item?.url || item?.videoUrl || item?.downloadUrl || "",
      score: scoreQuality(item),
    }))
    .filter((entry) => /^https?:\/\//i.test(entry.url));

  if (valid.length) {
    // Prefer the best quality up to 720p to reduce RAM/network pressure.
    // If the API only supplies higher/unknown qualities, use the best available.
    const atOrBelow720 = valid
      .filter((entry) => entry.score > 0 && entry.score <= 720)
      .sort((a, b) => b.score - a.score);

    const selected = atOrBelow720[0] || valid.sort((a, b) => b.score - a.score)[0];
    const best = selected.item;

    return {
      url: selected.url,
      quality: String(
        best?.quality || best?.label || best?.resolution || best?.name || ""
      ).trim(),
    };
  }

  const fallback =
    mediaInfo?.videoUrl ||
    mediaInfo?.video ||
    mediaInfo?.url ||
    mediaInfo?.downloadUrl ||
    "";

  return {
    url: typeof fallback === "string" ? fallback : "",
    quality: String(mediaInfo?.quality || "").trim(),
  };
}

function cleanTitle(value = "") {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title) return "";
  return title.length > 180 ? title.slice(0, 177) + "..." : title;
}

function makeCaption(mediaInfo = {}, selected = {}) {
  const title = cleanTitle(
    mediaInfo?.title || mediaInfo?.caption || mediaInfo?.description || ""
  );

  const views = formatNumber(
    mediaInfo?.viewCount ??
      mediaInfo?.views ??
      mediaInfo?.playCount ??
      mediaInfo?.plays
  );

  const likes = formatNumber(mediaInfo?.likeCount ?? mediaInfo?.likes);

  const uploaded = formatDate(
    mediaInfo?.publishTs ??
      mediaInfo?.publishedAt ??
      mediaInfo?.uploadDate ??
      mediaInfo?.date ??
      mediaInfo?.timestamp
  );

  const lines = ["╭─〔 *FACEBOOK* 〕"];
  if (title) lines.push(`├◦ *Title:* ${title}`);
  if (views) lines.push(`├◦ *Views:* ${views}`);
  if (likes) lines.push(`├◦ *Likes:* ${likes}`);
  if (uploaded) lines.push(`├◦ *Uploaded:* ${uploaded}`);
  if (selected?.quality) lines.push(`├◦ *Quality:* ${selected.quality}`);
  if (lines.length === 1) lines.push("├◦ *Video ready*");

  const last = lines.pop();
  lines.push(last.replace(/^├◦/, "╰◦"));
  lines.push("", "> POWERED BY BMEDIA-MD");
  return lines.join("\n");
}

async function fetchJson(url, timeoutMs = API_TIMEOUT_MS) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("This command requires Node.js 18+ built-in fetch.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "BMEDIA-MD/FB",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    // API responses are tiny JSON payloads; buffering this text is safe.
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}

    if (!res.ok) {
      throw new Error(data?.message || data?.error || `API HTTP ${res.status}`);
    }
    if (!data || typeof data !== "object") {
      throw new Error("Invalid API response.");
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Facebook API timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function responseBodyToNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function extensionFrom(contentType = "", mediaUrl = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("video/mp4")) return ".mp4";
  if (ct.includes("video/webm")) return ".webm";
  if (ct.includes("video/quicktime")) return ".mov";

  try {
    const ext = path.extname(new URL(mediaUrl).pathname).toLowerCase();
    if ([".mp4", ".webm", ".mov", ".m4v"].includes(ext)) return ext;
  } catch {}

  return ".mp4";
}

async function streamVideoToDisk(mediaUrl) {
  assertDiskSafe();
  ensureTempDir();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let tempPath = "";

  try {
    const res = await fetch(mediaUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 BMEDIA-MD/FB",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Facebook media download failed: HTTP ${res.status}`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html") || contentType.includes("text/plain")) {
      throw new Error(`Facebook media returned non-video content (${contentType || "unknown"}).`);
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_VIDEO_BYTES) {
      throw new Error(
        `Video is too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_VIDEO_MB} MB.`
      );
    }

    const readable = responseBodyToNodeStream(res.body);
    if (!readable) throw new Error("Unable to read Facebook media stream.");

    const ext = extensionFrom(contentType, mediaUrl);
    tempPath = path.join(
      TEMP_DIR,
      `${TEMP_PREFIX}${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`
    );

    let totalBytes = 0;
    let lastDiskCheck = 0;

    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;

        if (totalBytes > MAX_VIDEO_BYTES) {
          callback(
            new Error(
              `Video exceeded the ${MAX_VIDEO_MB} MB safety limit while downloading.`
            )
          );
          return;
        }

        // Disk checks are intentionally not performed on every chunk.
        if (totalBytes - lastDiskCheck >= 5 * 1024 * 1024) {
          lastDiskCheck = totalBytes;
          const used = getDiskUsagePercent();
          if (used >= DISK_STOP_PERCENT) {
            callback(
              new Error(
                `Server disk usage reached ${used.toFixed(1)}%. Download stopped.`
              )
            );
            return;
          }
        }

        callback(null, chunk);
      },
    });

    await pipeline(readable, limiter, fs.createWriteStream(tempPath));

    if (totalBytes < MIN_VALID_BYTES) {
      throw new Error("Downloaded Facebook video is too small or invalid.");
    }

    return {
      filePath: tempPath,
      size: totalBytes,
      mimetype: contentType.startsWith("video/") ? contentType.split(";")[0] : "video/mp4",
    };
  } catch (error) {
    removeFile(tempPath);
    if (error?.name === "AbortError") {
      throw new Error("Facebook video download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enqueueFacebookJob(task) {
  const jobsAhead = queueDepth;
  queueDepth += 1;

  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});

  try {
    return await run;
  } finally {
    queueDepth = Math.max(0, queueDepth - 1);
  }
}

export default {
  name: "fb",
  aliases: ["facebook", "fbvideo"],
  category: "DOWNLOAD",
  description: "Download a public Facebook video or reel using a low-RAM disk-streaming queue.",
  usage: "fb <facebook link>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const targetUrl = pickUrl(args);

    if (!targetUrl || !isFacebookUrl(targetUrl)) {
      return sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *FACEBOOK* 〕\n` +
            `╰◦ Usage: ${prefix}fb <facebook link>\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      );
    }

    const jobsAhead = queueDepth;

    if (jobsAhead > 0) {
      await sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *FACEBOOK* 〕\n` +
            `╰◦ Downloader busy. Your request is queued (${jobsAhead} ahead).\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      ).catch(() => {});
    }

    return enqueueFacebookJob(async () => {
      let tempPath = "";

      try {
        cleanupOwnTemp(30);
        assertDiskSafe();

        await sock.sendMessage(
          from,
          { react: { text: "⏳", key: m.key } }
        ).catch(() => {});

        const apiUrl = `${API_BASE}?url=${encodeURIComponent(targetUrl)}`;
        const data = await fetchJson(apiUrl);

        if (data?.success !== true) {
          throw new Error(
            data?.message ||
              data?.error ||
              "Facebook API did not return a successful result."
          );
        }

        const mediaInfo = data?.mediaInfo || data?.result || data?.data || {};
        const selected = chooseVideo(mediaInfo);

        if (!selected.url || !/^https?:\/\//i.test(selected.url)) {
          throw new Error("No downloadable Facebook video URL was returned.");
        }

        // Critical low-RAM change:
        // Stream remote media to disk first. Do NOT create a full video Buffer.
        const downloaded = await streamVideoToDisk(selected.url);
        tempPath = downloaded.filePath;

        const caption = makeCaption(mediaInfo, selected);

        // Baileys reads from a local file path. Only this one FB job is allowed
        // to reach the media-send stage at a time.
        const sent = await sock.sendMessage(
          from,
          {
            video: { url: tempPath },
            mimetype: downloaded.mimetype || "video/mp4",
            caption,
          },
          { quoted: m }
        );

        await sock.sendMessage(
          from,
          { react: { text: "✅", key: m.key } }
        ).catch(() => {});

        return sent;
      } catch (error) {
        await sock.sendMessage(
          from,
          { react: { text: "❌", key: m.key } }
        ).catch(() => {});

        return sock.sendMessage(
          from,
          {
            text:
              `╭─〔 *FACEBOOK* 〕\n` +
              `╰◦ ${error?.message || "Download failed."}\n\n` +
              `> POWERED BY BMEDIA-MD`,
          },
          { quoted: m }
        );
      } finally {
        // Immediate cleanup after success or failure.
        removeFile(tempPath);
        cleanupOwnTemp(30);
      }
    });
  },
};
