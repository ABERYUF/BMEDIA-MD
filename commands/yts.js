// commands/yts.js — BMEDIA-MD V6.0.2
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

function date(v = "") {
  const s = String(v).trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : s;
}

export default {
  name: "yts",
  aliases: ["ytsearch"],
  category: "SEARCH",
  description: "Search YouTube videos.",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const q = args.join(" ").trim();

    if (!q) {
      return sock.sendMessage(from, {
        text: `Usage: ${prefix}ytsearch <query>\nExample: ${prefix}ytsearch Bob`,
      }, { quoted: m });
    }

    try {
      const base = String(process.env.YTDL_API_URL || "").trim().replace(/\/+$/, "");
      const key = String(process.env.YTDL_API_KEY || "").trim();

      const r = await safeFetch(`${base}/api/yts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({ query: q }),
      });

      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}

      if (!r.ok) throw new Error(data?.error || `API error: HTTP ${r.status}`);
      if (!data?.status) throw new Error(data?.error || "Search failed.");

      const top = (data?.results?.videos || []).slice(0, 8);
      if (!top.length) {
        return sock.sendMessage(from, { text: `❌ No results for: *${q}*` }, { quoted: m });
      }

      const lines = ["🔎 *YouTube Search*", `Query: *${q}*`, ""];

      top.forEach((v, i) => {
        lines.push(`*${i + 1}.* *${v.title || "Untitled"}*`);
        if (v.duration) lines.push(`• Duration: ${v.duration}`);
        if (v.views != null) lines.push(`• Views: ${fmtViews(v.views)}`);
        if (v.uploaded) lines.push(`• Uploaded: ${date(v.uploaded)}`);
        if (v.author?.name) lines.push(`• Author: ${v.author.name}`);
        if (v.url) lines.push(`• Link: ${v.url}`);
        if (v.thumbnail) lines.push(`• Thumb: ${v.thumbnail}`);
        lines.push("");
      });

      await sock.sendMessage(from, { text: lines.join("\n") }, { quoted: m });

      const first = top[0];
      if (first?.thumbnail) {
        return sock.sendMessage(from, {
          image: { url: first.thumbnail },
          caption: `🎬 *Top Result*\n*${first.title || "Untitled"}*\n${first.url || ""}`,
        }, { quoted: m });
      }

      return true;
    } catch (e) {
      return sock.sendMessage(from, {
        text: `❌ Failed: ${e?.message || e}`,
      }, { quoted: m });
    }
  },
};
