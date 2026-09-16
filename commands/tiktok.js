// commands/tiktok.js
// BMEDIA-MD — TikTok downloader
// Primary: tdownv4.sl-bjs.workers.dev
// Fallback: clipx.zamdev.workers.dev
// No API key, no temp files, no ffmpeg, no full-video Buffer.

const PRIMARY_API = "https://tdownv4.sl-bjs.workers.dev/";
const FALLBACK_API = "https://clipx.zamdev.workers.dev/";

function pickUrl(args = []) {
  const text = args.join(" ").trim();
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function isTikTokUrl(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "vm.tiktok.com" ||
      host === "vt.tiktok.com"
    );
  } catch {
    return false;
  }
}

function cleanText(value = "", max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && /[kmb]$/i.test(value.trim())) return value.trim();

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";

  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.trunc(n));
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";

  try {
    let d;
    if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
      const n = Number(value);
      d = new Date(String(Math.trunc(n)).length <= 10 ? n * 1000 : n);
    } else {
      d = new Date(value);
    }

    if (Number.isNaN(d.getTime())) return "";

    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(d);
  } catch {
    return "";
  }
}

async function fetchJson(url, timeoutMs = 30000) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Node.js 18+ built-in fetch is required.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "BMEDIA-MD/TikTok",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) throw new Error(data?.error || data?.message || `API HTTP ${res.status}`);
    if (!data || typeof data !== "object") throw new Error("Invalid API response.");

    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TikTok API timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePrimary(data = {}) {
  const author = data?.author || {};

  return {
    type: String(data?.content_type || "video").toLowerCase(),
    title: cleanText(data?.title),
    username: cleanText(author?.username || author?.nickname, 60),
    views: author?.view_count ?? data?.view_count ?? data?.views,
    likes: author?.like_count ?? data?.like_count ?? data?.likes,
    comments: author?.comment_count ?? data?.comment_count ?? data?.comments,
    shares: author?.share_count ?? data?.share_count ?? data?.shares,
    date: data?.create_time ?? data?.publishTs ?? data?.timestamp,
    video: data?.download_url || data?.video_url || data?.video || "",
    audio: author?.audio_url || data?.audio_url || data?.music || "",
    images: Array.isArray(data?.images) ? data.images.filter(Boolean) : [],
  };
}

function normalizeFallback(data = {}) {
  if (data?.success !== true || !data?.data) {
    throw new Error(data?.error || "Fallback API failed.");
  }

  const d = data.data || {};
  const stats = d.stats || {};
  const video = d.video || {};
  const author = d.author || {};

  return {
    type: Array.isArray(d.images) && d.images.length ? "image" : "video",
    title: cleanText(d.title),
    username: cleanText(author.username || author.nickname, 60),
    views: stats.views ?? stats.play_count,
    likes: stats.digg_count,
    comments: stats.comment_count,
    shares: stats.share_count,
    date: d.create_time,
    video: video.hd_mp4 || video.standard_mp4 || video.wmplay || "",
    audio: d.audio?.play || "",
    images: Array.isArray(d.images) ? d.images.filter(Boolean) : [],
  };
}

async function getTikTokData(targetUrl) {
  let primaryError = null;

  try {
    const url = `${PRIMARY_API}?down=${encodeURIComponent(targetUrl)}`;
    const data = await fetchJson(url);
    const normalized = normalizePrimary(data);

    if (normalized.video || normalized.images.length) return normalized;
    primaryError = new Error("Primary API returned no downloadable media.");
  } catch (error) {
    primaryError = error;
  }

  try {
    const url = `${FALLBACK_API}?url=${encodeURIComponent(targetUrl)}&quality=best&format=false&meta=false&trace=false&contact=false`;
    const data = await fetchJson(url);
    const normalized = normalizeFallback(data);

    if (!normalized.video && !normalized.images.length) {
      throw new Error("Fallback API returned no downloadable media.");
    }

    return normalized;
  } catch (fallbackError) {
    throw new Error(`Both TikTok APIs failed. ${fallbackError?.message || primaryError?.message || "No downloadable media found."}`);
  }
}

function makeCaption(info = {}) {
  const title = cleanText(info.title);
  const username = cleanText(info.username, 60);
  const views = formatNumber(info.views);
  const likes = formatNumber(info.likes);
  const comments = formatNumber(info.comments);
  const uploaded = formatDate(info.date);

  const body = [];
  if (title) body.push(`*Title:* ${title}`);
  if (username) body.push(`*Creator:* @${username.replace(/^@/, "")}`);
  if (views) body.push(`*Views:* ${views}`);
  if (likes) body.push(`*Likes:* ${likes}`);
  if (comments) body.push(`*Comments:* ${comments}`);
  if (uploaded) body.push(`*Uploaded:* ${uploaded}`);
  if (!body.length) body.push("*Media ready*");

  const lines = ["╭─〔 *TIKTOK* 〕"];
  body.forEach((line, index) => {
    lines.push(`${index === body.length - 1 ? "╰◦" : "├◦"} ${line}`);
  });
  lines.push("", "> POWERED BY BMEDIA-MD");
  return lines.join("\n");
}

async function sendImages(sock, from, m, images, caption) {
  const list = images.slice(0, 10);

  for (let i = 0; i < list.length; i++) {
    await sock.sendMessage(
      from,
      {
        image: { url: list[i] },
        ...(i === 0 ? { caption } : {}),
      },
      i === 0 ? { quoted: m } : {}
    );
  }
}

export default {
  name: "tiktok",
  aliases: ["tt", "tik"],
  category: "DOWNLOAD",
  description: "Download public TikTok videos or photo posts.",
  usage: "tiktok <TikTok link>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const targetUrl = pickUrl(args);

    if (!targetUrl || !isTikTokUrl(targetUrl)) {
      return sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *TIKTOK* 〕\n` +
            `╰◦ Usage: ${prefix}tiktok <TikTok link>\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      );
    }

    try {
      await sock.sendMessage(from, { react: { text: "⏳", key: m.key } }).catch(() => {});

      const info = await getTikTokData(targetUrl);
      const caption = makeCaption(info);

      if (info.images.length) {
        await sendImages(sock, from, m, info.images, caption);
        await sock.sendMessage(from, { react: { text: "✅", key: m.key } }).catch(() => {});
        return;
      }

      if (!info.video || !/^https?:\/\//i.test(info.video)) {
        throw new Error("No downloadable TikTok video was returned.");
      }

      const sent = await sock.sendMessage(
        from,
        {
          video: { url: info.video },
          mimetype: "video/mp4",
          caption,
        },
        { quoted: m }
      );

      await sock.sendMessage(from, { react: { text: "✅", key: m.key } }).catch(() => {});
      return sent;
    } catch (error) {
      await sock.sendMessage(from, { react: { text: "❌", key: m.key } }).catch(() => {});

      return sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *TIKTOK* 〕\n` +
            `╰◦ ${error?.message || "Download failed."}\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      );
    }
  },
};
