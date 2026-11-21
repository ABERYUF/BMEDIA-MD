
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


function pickInput(args = []) {
  const text = args.join(" ").trim();

  const url = text.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  )?.[0];

  return url || text;
}

async function fetchAudio(input, filePath) {
  const { baseUrl, apiKey } = apiConfig();

  const response = await safeFetch(`${baseUrl}/youtube/audio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    throw new Error(await apiError(response));
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  // Preferred V6.3 behavior: backend returns final MP3 binary.
  if (!contentType.includes("application/json")) {
    const size = await saveResponseBody(response, filePath);

    if (size < 1000) {
      throw new Error("Downloaded audio is empty.");
    }

    return {
      title: cleanName(
        decodeHeader(response.headers.get("x-bmedia-title") || ""),
        "YouTube Audio"
      ),
    };
  }

  // Backward compatibility with earlier backend builds that returned JSON.
  const data = await response.json();

  const mediaUrl =
    data?.mediaUrl ||
    data?.downloadUrl ||
    data?.url ||
    data?.audio?.url ||
    "";

  if (!data?.status || !mediaUrl) {
    throw new Error(data?.error || "Audio was not prepared.");
  }

  const size = await downloadUrlToFile(
    mediaUrl,
    filePath,
    "audio/mpeg,audio/mp4,audio/*;q=0.9,*/*;q=0.8"
  );

  if (size < 1000) {
    throw new Error("Downloaded audio is empty.");
  }

  return {
    title: cleanName(data.title, "YouTube Audio"),
  };
}

function start(ctx, input) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const dir = path.join(process.cwd(), "temp");
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(
      dir,
      `${Date.now()}_${Math.random().toString(16).slice(2)}.mp3`
    );

    try {
      await sock.sendMessage(from, {
        react: { text: "⏳", key: m.key },
      }).catch(() => {});

      const result = await fetchAudio(input, filePath);

      await sock.sendMessage(
        from,
        {
          audio: { url: filePath },
          mimetype: "audio/mpeg",
          ptt: false,
          fileName: `${result.title}.mp3`,
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
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Download YouTube audio.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = pickInput(args);

    if (!input) {
      return sock.sendMessage(
        from,
        { text: `Usage: ${prefix}yta <YouTube link or song title>` },
        { quoted: m }
      );
    }

    start(ctx, input);
    return true;
  },
};
