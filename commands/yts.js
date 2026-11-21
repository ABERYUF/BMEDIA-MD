// commands/yts.js (ESM)
// BMEDIA-MD — YouTube search using private BMEDIA-YTDL.
// Preserves the old yts/ytsearch output style.

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

export default {
  name: "yts",
  aliases: ["ytsearch"],
  category: "SEARCH",
  description: "Search YouTube videos (title, thumbnail, url, info).",

  async execute(ctx) {
    const { sock, m, from, args, prefix } = ctx;
    const q = (args || []).join(" ").trim();

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

    const baseUrl = String(process.env.YTDL_API_URL || "")
      .trim()
      .replace(/\/+$/, "");

    const apiKey = String(process.env.YTDL_API_KEY || "").trim();

    if (!baseUrl) {
      return sock.sendMessage(
        from,
        { text: "❌ Failed: YTDL_API_URL is missing in .env" },
        { quoted: m }
      );
    }

    if (!apiKey) {
      return sock.sendMessage(
        from,
        { text: "❌ Failed: YTDL_API_KEY is missing in .env" },
        { quoted: m }
      );
    }

    try {
      const res = await safeFetch(
        `${baseUrl}/youtube/search?q=${encodeURIComponent(q)}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-api-key": apiKey,
          },
        }
      );

      if (!res.ok) {
        let reason = `API error: HTTP ${res.status}`;

        try {
          const body = await res.json();
          reason = body?.error || body?.details || reason;
        } catch {}

        throw new Error(reason);
      }

      const data = await res.json().catch(() => null);

      if (!data || data.success !== true) {
        throw new Error(data?.error || "Invalid API response");
      }

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
        if (v.uploaded) lines.push(`• Uploaded: ${v.uploaded}`);
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
    } catch (e) {
      return sock.sendMessage(
        from,
        { text: `❌ Failed: ${e?.message || e}` },
        { quoted: m }
      );
    }
  },
};
