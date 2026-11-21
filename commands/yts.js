// commands/yts.js (ESM)
// BMEDIA-MD V6 — YouTube search using private BMEDIA-YTDL V6 API.
// Preserves the old yts/ytsearch format.

async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function fmtViews(n) {
  const num = Number(n);

  if (!Number.isFinite(num)) return String(n || "");
  if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, "") + "K";

  return String(num);
}

function formatUploadDate(value = "") {
  const v = String(value || "").trim();

  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }

  return v;
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

export default {
  name: "yts",
  aliases: ["ytsearch"],
  category: "SEARCH",
  description: "Search YouTube videos (title, thumbnail, url, info).",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const q = args.join(" ").trim();

    if (!q) {
      return sock.sendMessage(
        from,
        {
          text:
            `Usage: ${prefix}ytsearch <query>\n` +
            `Example: ${prefix}ytsearch Bob`,
        },
        { quoted: m }
      );
    }

    try {
      const { baseUrl, apiKey } = apiConfig();

      const response = await safeFetch(
        `${baseUrl}/youtube/search?q=${encodeURIComponent(q)}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-api-key": apiKey,
          },
        }
      );

      const data = await readApiResponse(response);
      const videos = data?.results?.videos || [];

      if (!videos.length) {
        return sock.sendMessage(
          from,
          { text: `❌ No results for: *${q}*` },
          { quoted: m }
        );
      }

      const top = videos.slice(0, 8);
      const lines = [];

      lines.push("🔎 *YouTube Search*");
      lines.push(`Query: *${q}*`);
      lines.push("");

      top.forEach((v, i) => {
        lines.push(`*${i + 1}.* *${v.title || "Untitled"}*`);

        if (v.duration) lines.push(`• Duration: ${v.duration}`);
        if (v.views != null) lines.push(`• Views: ${fmtViews(v.views)}`);
        if (v.uploaded) lines.push(`• Uploaded: ${formatUploadDate(v.uploaded)}`);
        if (v.author?.name) lines.push(`• Author: ${v.author.name}`);
        if (v.url) lines.push(`• Link: ${v.url}`);
        if (v.thumbnail) lines.push(`• Thumb: ${v.thumbnail}`);

        lines.push("");
      });

      await sock.sendMessage(
        from,
        { text: lines.join("\n") },
        { quoted: m }
      );

      const first = top[0];

      if (first?.thumbnail) {
        return sock.sendMessage(
          from,
          {
            image: { url: first.thumbnail },
            caption:
              `🎬 *Top Result*\n` +
              `*${first.title || "Untitled"}*\n` +
              (first.url ? `Link: ${first.url}` : ""),
          },
          { quoted: m }
        );
      }

      return true;
    } catch (error) {
      return sock.sendMessage(
        from,
        { text: `❌ Failed: ${error?.message || error}` },
        { quoted: m }
      );
    }
  },
};
