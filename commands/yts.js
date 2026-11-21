// commands/yts.js
// BMEDIA-MD — Fast local YouTube search
// Uses yt-search directly from the bot.
// No third-party search API is required.

import {
  searchYouTube,
  formatViews,
} from "../utils/bmediaYouTube.js";

export default {
  name: "yts",
  aliases: ["ytsearch"],
  category: "SEARCH",
  description: "Search YouTube quickly.",
  usage: "yts <query>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const query = args.join(" ").trim();

    if (!query) {
      return sock.sendMessage(
        from,
        {
          text:
            `Usage: ${prefix}yts <query>\n` +
            `Example: ${prefix}yts Alan Walker Faded`,
        },
        { quoted: m }
      );
    }

    try {
      await sock
        .sendMessage(from, { react: { text: "🔎", key: m.key } })
        .catch(() => {});

      const videos = await searchYouTube(query, 6);

      const lines = [
        "╭─〔 *YOUTUBE SEARCH* 〕",
        `├◦ Query: *${query}*`,
        "╰────────────",
        "",
      ];

      videos.forEach((video, index) => {
        lines.push(`*${index + 1}. ${video.title}*`);

        const info = [];

        if (video.duration) info.push(video.duration);

        const views = formatViews(video.views);
        if (views) info.push(`${views} views`);

        if (video.author) info.push(video.author);

        if (info.length) {
          lines.push(info.join(" • "));
        }

        lines.push(video.url);
        lines.push("");
      });

      lines.push("> POWERED BY BMEDIA-MD");

      const sent = await sock.sendMessage(
        from,
        { text: lines.join("\n") },
        { quoted: m }
      );

      await sock
        .sendMessage(from, { react: { text: "✅", key: m.key } })
        .catch(() => {});

      return sent;
    } catch (error) {
      await sock
        .sendMessage(from, { react: { text: "❌", key: m.key } })
        .catch(() => {});

      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE SEARCH ERROR* 〕",
            `╰◦ ${error?.message || "Search failed."}`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        { quoted: m }
      );
    }
  },
};
