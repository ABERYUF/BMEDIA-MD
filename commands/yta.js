// commands/yta.js
// BMEDIA-MD V6 — YouTube audio via private BMEDIA-YTDL V6 API.
// Keeps the old BMEDIA-MD command object format.

import fs from "fs";
import path from "path";
import { Readable } from "stream";

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function responseBodyToNodeReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return null;
}

function cleanFileName(name) {
  return String(name || "YouTube Audio")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeInput(args = []) {
  const input = args.join(" ").trim();

  const match = input.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/[^\s]+|youtu\.be\/[^\s]+)/i
  );

  if (match?.[0]) return match[0];

  return input
    .replace(/^[.!/#]\s*(?:yta|ytmp3|youtubeaudio|play|song)\s+/i, "")
    .trim();
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

async function readApiResponse(response) {
  const text = await response.text();

  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      `API error: HTTP ${response.status}`
    );
  }

  if (!data || data.status !== true) {
    throw new Error(data?.error || "Invalid BMEDIA-YTDL response.");
  }

  return data;
}

async function getAudioInfo(input) {
  const { baseUrl, apiKey } = apiConfig();

  const response = await safeFetch(`${baseUrl}/youtube/audio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ input }),
  });

  return readApiResponse(response);
}

async function downloadToFile(url, filePath) {
  const response = await safeFetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "audio/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Audio file download failed: HTTP ${response.status}`);
  }

  const stream = responseBodyToNodeReadable(response.body);
  if (!stream) throw new Error("Audio response had no body.");

  const ws = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    stream.pipe(ws);
  });

  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

  if (!stat?.size) {
    throw new Error("Downloaded audio file is empty.");
  }
}

function runDownload(ctx, input) {
  const { sock, m, from } = ctx;

  setTimeout(async () => {
    const tempDir = path.join(process.cwd(), "temp");

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let tempPath = "";

    await sock.sendMessage(from, {
      react: { text: "⏳", key: m.key },
    }).catch(() => {});

    try {
      const data = await getAudioInfo(input);

      const title = cleanFileName(data.title || "YouTube Audio");
      const ext =
        String(data.audio?.ext || data.fileName || "")
          .toLowerCase()
          .includes("m4a")
          ? "m4a"
          : "mp3";

      const mimetype =
        String(data.mimetype || "").trim() ||
        (ext === "m4a" ? "audio/mp4" : "audio/mpeg");

      tempPath = path.join(tempDir, `${id}.${ext}`);

      await downloadToFile(data.downloadUrl || data.url, tempPath);

      await sock.sendMessage(
        from,
        {
          audio: { url: tempPath },
          mimetype,
          ptt: false,
          fileName: `${title}.${ext}`,
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
        {
          text:
            `❌ download unsuccessful\n` +
            `Reason: ${error?.message || error}`,
        },
        { quoted: m }
      ).catch(() => {});
    } finally {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {}
      }
    }
  }, 250);
}

export default {
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "play", "song"],
  category: "DOWNLOAD",
  description: "Search for or download YouTube audio.",
  usage: "yta <YouTube link or song title>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = normalizeInput(args);

    if (!input) {
      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE AUDIO* 〕",
            `├◦ ${prefix}yta <song title>`,
            `╰◦ ${prefix}yta <YouTube link>`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        { quoted: m }
      );
    }

    runDownload(ctx, input);
    return true;
  },
};
