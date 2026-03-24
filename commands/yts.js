// commands/ytsearch.js (ESM)

// Endpoint: https://eliteprotech-apis.zone.id/ytsearch?q=...

// Usage: !ytsearch <query>

// Shows top results with title, url, thumbnail, duration, views, uploaded, author.

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

        { text: `Usage: ${prefix}ytsearch <query>\nExample: ${prefix}ytsearch Bob` },

        { quoted: m }

      );

    }

    const apiUrl = `https://eliteprotech-apis.zone.id/ytsearch?q=${encodeURIComponent(q)}`;

    try {

      try { await sock.sendPresenceUpdate?.("composing", from); } catch {}

      const res = await safeFetch(apiUrl, { method: "GET", headers: { accept: "application/json" } });

      if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);

      const data = await res.json().catch(() => null);

      if (!data || data.success !== true) throw new Error(data?.message || "Invalid API response");

      const videos = data?.results?.videos || [];

      if (!videos.length) {

        return sock.sendMessage(from, { text: `❌ No results for: *${q}*` }, { quoted: m });

      }

      // show top 8 results to avoid spam

      const top = videos.slice(0, 8);

      const lines = [];

      lines.push(`🔎 *YouTube Search*`);

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

        lines.push(""); // spacer

      });

      // Send as text (links are clickable in WhatsApp)

      await sock.sendMessage(from, { text: lines.join("\n") }, { quoted: m });

      // Also send first thumbnail as an image preview (optional but nice)

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

    } catch (e) {

      return sock.sendMessage(

        from,

        { text: `❌ Failed: ${e?.message || e}` },

        { quoted: m }

      );

    } finally {

      try { await sock.sendPresenceUpdate?.("paused", from); } catch {}

    }

  },

};