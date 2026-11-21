// commands/yta.js
// BMEDIA-MD — Fast YouTube audio
// Accepts either:
//   .yta <YouTube link>
//   .yta <song/title>
//
// No bot-side ffmpeg.
// No bot-side temp file.
// BMEDIA-YTDL returns native M4A and Baileys sends it directly.

import {
  resolveYouTubeInput,
  getAudioDownload,
  safeFileName,
} from "../utils/bmediaYouTube.js";

export default {
  name: "yta",
  aliases: ["ytmp3", "youtubeaudio", "song", "play", "mp3", "music"],
  category: "DOWNLOAD",
  description: "Download YouTube audio quickly.",
  usage: "yta <YouTube link or title>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const input = args.join(" ").trim();

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

    try {
      await sock
        .sendMessage(from, { react: { text: "⏳", key: m.key } })
        .catch(() => {});

      const resolved = await resolveYouTubeInput(input);
      const data = await getAudioDownload(resolved.url, 128);

      const mediaUrl = data.downloadUrl || data.url;
      if (!mediaUrl) {
        throw new Error("BMEDIA-YTDL returned no audio URL.");
      }

      const title =
        data.title ||
        resolved.searchResult?.title ||
        "YouTube Audio";

      const sent = await sock.sendMessage(
        from,
        {
          audio: { url: mediaUrl },
          mimetype: "audio/mp4",
          ptt: false,
          fileName: `${safeFileName(title, "YouTube Audio")}.m4a`,
        },
        {
          quoted: m,
          mediaUploadTimeoutMs: 180_000,
        }
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
            "╭─〔 *YOUTUBE AUDIO ERROR* 〕",
            `╰◦ ${error?.message || "Audio download failed."}`,
            "",
            "> POWERED BY BMEDIA-MD",
          ].join("\n"),
        },
        { quoted: m }
      );
    }
  },
};
