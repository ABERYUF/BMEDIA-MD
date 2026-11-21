// commands/yts.js — BMEDIA-MD V6.1.0
async function safeFetch(url, opts) {
  if (globalThis.fetch) return fetch(url, opts);
  const mod = await import("node-fetch");
  return mod.default(url, opts);
}

function fmtViews(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n || "");
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(v);
}

function fmtDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return "";

  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(v = "") {
  const s = String(v).trim();
  return /^\d{8}$/.test(s)
    ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    : s;
}

export default {
  name: "yts",
  aliases: ["ytsearch"],
  category: "SEARCH",
  description: "Search YouTube videos.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const query = args.join(" ").trim();

    if (!query) {
      return sock.sendMessage(
        from,
        {
          text:
            `Usage: ${prefix}ytsearch <query>\n` +
            `Example: ${prefix}ytsearch MrBeast`,
        },
        { quoted: m }
      );
    }

    try {
      const base = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
      const key = String(process.env.YTDL_API_KEY || "").trim();

      const r = await safeFetch(`${base}/api/youtube`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          action: "search",
          input: query,
        }),
      });

      const text = await r.text();
      let data = null;

      try { data = JSON.parse(text); } catch {}

      if (!r.ok) {
        throw new Error(data?.error || `API error: HTTP ${r.status}`);
      }

      if (!data?.status) {
        throw new Error(data?.error || "Search failed.");
      }

      const top = (data?.results?.videos || []).slice(0, 8);

      if (!top.length) {
        return sock.sendMessage(
          from,
          { text: `❌ No results for: *${query}*` },
          { quoted: m }
        );
      }

      const lines = [
        "🔎 *YouTube Search*",
        `Query: *${query}*`,
        "",
      ];

      top.forEach((v, i) => {
        lines.push(`*${i + 1}.* *${v.title || "Untitled"}*`);
        if (v.duration) lines.push(`• Duration: ${fmtDuration(v.duration)}`);
        if (v.views != null) lines.push(`• Views: ${fmtViews(v.views)}`);
        if (v.uploaded) lines.push(`• Uploaded: ${fmtDate(v.uploaded)}`);
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
              `${first.url || ""}`,
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
