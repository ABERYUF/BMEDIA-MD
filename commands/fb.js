// commands/fb.js
// BMEDIA-MD — Facebook downloader using AHM7xMakki AllDL API
// No temp files, no ffmpeg, no full-video Buffer.
// Media is handed to Baileys as a direct URL.

const API_BASE = "https://ahm7xmakki.com/api/alldl";

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
    .filter((item) => {
      const url = item?.url || item?.videoUrl || item?.downloadUrl;
      return typeof url === "string" && /^https?:\/\//i.test(url);
    })
    .sort((a, b) => scoreQuality(b) - scoreQuality(a));

  if (valid.length) {
    const best = valid[0];
    return {
      url: best.url || best.videoUrl || best.downloadUrl,
      quality: String(
        best.quality ||
        best.label ||
        best.resolution ||
        best.name ||
        ""
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
  const title = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return "";
  return title.length > 180 ? title.slice(0, 177) + "..." : title;
}

function makeCaption(mediaInfo = {}, selected = {}) {
  const title = cleanTitle(
    mediaInfo?.title ||
    mediaInfo?.caption ||
    mediaInfo?.description ||
    ""
  );

  const views = formatNumber(
    mediaInfo?.viewCount ??
    mediaInfo?.views ??
    mediaInfo?.playCount ??
    mediaInfo?.plays
  );

  const likes = formatNumber(
    mediaInfo?.likeCount ??
    mediaInfo?.likes
  );

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

  // Keep the card clean even when the API returns very little metadata.
  if (lines.length === 1) {
    lines.push("├◦ *Video ready*");
  }

  // Turn the final branch into the closing line.
  const last = lines.pop();
  lines.push(last.replace(/^├◦/, "╰◦"));

  lines.push("", "> POWERED BY BMEDIA-MD");
  return lines.join("\n");
}

async function fetchJson(url) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("This command requires Node.js 18+ built-in fetch.");
  }

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "BMEDIA-MD/FB",
    },
    redirect: "follow",
  });

  const text = await res.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `API HTTP ${res.status}`
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid API response.");
  }

  return data;
}

// Shared process-level queue for Facebook downloads.
// The worker runs outside the command handler, so waiting in this queue does not
// consume the command handler's own timeout window.
const QUEUE_KEY = "__BMEDIA_FB_DOWNLOAD_QUEUE_V1__";

function getQueueState() {
  if (!globalThis[QUEUE_KEY]) {
    globalThis[QUEUE_KEY] = {
      running: false,
      jobs: [],
    };
  }
  return globalThis[QUEUE_KEY];
}

function queuePosition() {
  const state = getQueueState();
  return state.jobs.length + (state.running ? 1 : 0) + 1;
}

async function processFacebookJob(job) {
  const { sock, m, from, targetUrl } = job;

  try {
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

    const mediaInfo =
      data?.mediaInfo ||
      data?.result ||
      data?.data ||
      {};

    const selected = chooseVideo(mediaInfo);

    if (!selected.url || !/^https?:\/\//i.test(selected.url)) {
      throw new Error("No downloadable Facebook video URL was returned.");
    }

    const caption = makeCaption(mediaInfo, selected);

    // Keep the original low-memory flow: hand the remote URL directly to Baileys.
    // No manual full-video Buffer, temp file, or ffmpeg processing here.
    const sent = await sock.sendMessage(
      from,
      {
        video: { url: selected.url },
        mimetype: "video/mp4",
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
    ).catch(() => {});
  }
}

async function runQueue() {
  const state = getQueueState();
  if (state.running) return;

  state.running = true;

  try {
    while (state.jobs.length) {
      const job = state.jobs.shift();
      await processFacebookJob(job);

      // Yield once so completed media work can release resources before the next job.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    state.running = false;

    // A job may have arrived between the final length check and setting running=false.
    if (state.jobs.length) {
      void runQueue();
    }
  }
}

function enqueueFacebookJob(job) {
  const state = getQueueState();
  const position = queuePosition();
  state.jobs.push(job);
  void runQueue();
  return position;
}

export default {
  name: "fb",
  aliases: ["facebook", "fbvideo"],
  category: "DOWNLOAD",
  description: "Download a public Facebook video or reel.",
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

    const state = getQueueState();
    const wasBusy = state.running || state.jobs.length > 0;
    const position = enqueueFacebookJob({
      sock,
      m,
      from,
      targetUrl,
    });

    // Return immediately after queueing. This prevents time spent waiting behind
    // another Facebook download from being counted against the command timeout.
    if (wasBusy) {
      await sock.sendMessage(
        from,
        {
          text:
            `╭─〔 *FACEBOOK QUEUE* 〕\n` +
            `╰◦ Another Facebook download is already running. Your request is queued at position ${position} and will start automatically.\n\n` +
            `> POWERED BY BMEDIA-MD`,
        },
        { quoted: m }
      ).catch(() => {});
    }

    return;

  },
};
