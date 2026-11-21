// commands/ytv.js
// BMEDIA-MD — Fast YouTube video
// Accepts either:
//   .ytv <YouTube link>
//   .ytv <video title>
//
// BMEDIA-YTDL performs the lightweight video+audio stream-copy mux.
// The WhatsApp bot does not run ffmpeg and does not save temp files.

import {
  resolveYouTubeInput,
  getVideoDownload,
} from "../utils/bmediaYouTube.js";

export default {
  name: "ytv",
  aliases: ["ytmp4", "youtubevideo"],
  category: "DOWNLOAD",
  description: "Download YouTube video quickly.",
  usage: "ytv <YouTube link or title>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = args.join(" ").trim();

    if (!input) {
      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 *YOUTUBE VIDEO* 〕",
            `├◦ ${prefix}ytv <video title>`,
            `╰◦ ${prefix}ytv <YouTube link>`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        {
          quoted: m,
          mediaUploadTimeoutMs: 180_000,
        }
      );
    }

    try {
      await sock
        .sendMessage(from, { react: { text: "⏳", key: m.key } })
        .catch(() => {});

      const resolved = await resolveYouTubeInput(input);
      const data = await getVideoDownload(resolved.url, 720);

      const mediaUrl = data.downloadUrl || data.url;
      if (!mediaUrl) {
        throw new Error("BMEDIA-YTDL returned no video URL.");
      }

      const title =
        data.title ||
        resolved.searchResult?.title ||
        "YouTube Video";

      const caption = [
        "╭─〔 *YOUTUBE VIDEO* 〕",
        `├◦ *${title}*`,
        `╰◦ Quality: ${data.quality || "720p"}`,
        "",
        "> POWERED BY BMEDIA-MD",
      ].join("\n");

      const sent = await sock.sendMessage(
        from,
        {
          video: { url: mediaUrl },
          mimetype: "video/mp4",
          caption,
        },
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
            "╭─〔 *YOUTUBE VIDEO ERROR* 〕",
            `╰◦ ${error?.message || "Video download failed."}`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        { quoted: m }
      );
    }
  },
};
