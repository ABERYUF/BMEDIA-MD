
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function toNodeStream(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function apiConfig() {
  const baseUrl = String(process.env.YTDL_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = String(process.env.YTDL_API_KEY || "").trim();

  if (!baseUrl) throw new Error("YTDL_API_URL is missing in .env");
  if (!apiKey) throw new Error("YTDL_API_KEY is missing in .env");

  return { baseUrl, apiKey };
}

function decodeHeader(v = "") {
  try { return decodeURIComponent(v); }
  catch { return ""; }
}

function cleanName(value = "", fallback = "YouTube Media") {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

async function apiError(response) {
  try {
    const data = await response.json();
    return data?.error || data?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function saveResponseBody(response, filePath) {
  const body = toNodeStream(response.body);
  if (!body) throw new Error("Media response had no body.");

  await pipeline(body, fs.createWriteStream(filePath));

  const stat = fs.statSync(filePath);
  return stat.size;
}

async function downloadUrlToFile(url, filePath, accept) {
  const r = await safeFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept,
    },
  });

  if (!r.ok) {
    throw new Error(`Media download failed: HTTP ${r.status}`);
  }

  return saveResponseBody(r, filePath);
}


function pickUrl(args = []) {
  const text = args.join(" ").trim();

  return text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0] || "";
}

async function fetchVideo(url, filePath) {
  const { baseUrl, apiKey } = apiConfig();

  const response = await safeFetch(`${baseUrl}/youtube/video`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    throw new Error(await apiError(response));
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  // Preferred V6.3 behavior: backend returns final MP4 binary.
  if (!contentType.includes("application/json")) {
    const size = await saveResponseBody(response, filePath);

    if (size < 5000) {
      throw new Error("Downloaded video is invalid.");
    }

    return {
      title: cleanName(
        decodeHeader(response.headers.get("x-bmedia-title") || ""),
        "YouTube Video"
      ),
    };
  }

  // Backward compatibility with earlier backend builds that returned JSON.
  const data = await response.json();

  const mediaUrl =
    data?.mediaUrl ||
    data?.downloadUrl ||
    data?.url ||
    data?.video?.[0]?.url ||
    "";

  if (!data?.status || !mediaUrl) {
    throw new Error(data?.error || "Video was not prepared.");
  }

  const size = await downloadUrlToFile(
    mediaUrl,
    filePath,
    "video/mp4,video/*;q=0.9,*/*;q=0.8"
  );

  if (size < 5000) {
    throw new Error("Downloaded video is invalid.");
  }

  return {
    title: cleanName(data.title, "YouTube Video"),
  };
}

function start(ctx, url) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const dir = path.join(process.cwd(), "download_temp");
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(
      dir,
      `${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`
    );

    try {
      await sock.sendMessage(from, {
        react: { text: "⏳", key: m.key },
      }).catch(() => {});

      const result = await fetchVideo(url, filePath);

      await sock.sendMessage(
        from,
        {
          video: { url: filePath },
          mimetype: "video/mp4",
          caption: result.title,
        },
        { quoted: m }
      );

      await sock.sendMessage(from, {
        react: { text: "✅", key: m.key },
      }).catch(() => {});
    } catch (error) {
      await sock.sendMessage(from, {
        react: { text: "❌", key: m.key },
      }).catch(() => {});

      await sock.sendMessage(
        from,
        { text: `❌ download unsuccessful\nReason: ${error?.message || error}` },
        { quoted: m }
      ).catch(() => {});
    } finally {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }, 250);
}

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const url = pickUrl(args);

    if (!url) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}ytv <YouTube link>` },
        { quoted: m }
      );
    }

    start(ctx, url);
    return true;
  },
};
