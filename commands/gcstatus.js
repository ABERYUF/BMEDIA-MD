// commands/gcstatus.js (ESM)

// Post a "Group Status" (groupStatusMessageV2) in the current group.

// Supports:

// - Text: gcstatus <text>

// - Reply to image/video/audio: gcstatus [optional caption text]

//

// If nothing provided: replies with usage help.

import {

  proto,

  generateWAMessageFromContent,

  prepareWAMessageMedia,

  downloadContentFromMessage,

} from "@whiskeysockets/baileys";

import { isOwner } from "../checks/isOwner.js";

import { isSudo } from "../checks/isSudo.js";

function isPrivileged(ctx) {

  const jid =

    ctx?.senderJid ||

    ctx?.sender ||

    ctx?.participant ||

    ctx?.m?.key?.participant ||

    "";

  try {

    if (typeof isOwner === "function") {

      if (isOwner(jid) === true) return true;

      if (isOwner({ senderJid: jid, sender: jid }) === true) return true;

    }

  } catch {}

  try {

    if (typeof isSudo === "function" && isSudo(jid)) return true;

  } catch {}

  return false;

}

function getQuotedMessage(m) {

  const ext = m?.message?.extendedTextMessage;

  const ctxInfo = ext?.contextInfo;

  return ctxInfo?.quotedMessage || null;

}

async function streamToBuffer(stream) {

  const chunks = [];

  for await (const chunk of stream) chunks.push(chunk);

  return Buffer.concat(chunks);

}

async function downloadQuotedMedia(quotedMsg) {

  // Supports imageMessage/videoMessage/audioMessage

  const qImg = quotedMsg?.imageMessage;

  if (qImg) {

    const stream = await downloadContentFromMessage(qImg, "image");

    const buffer = await streamToBuffer(stream);

    return {

      kind: "image",

      buffer,

      mimetype: qImg.mimetype || "image/jpeg",

      caption: qImg.caption || "",

    };

  }

  const qVid = quotedMsg?.videoMessage;

  if (qVid) {

    const stream = await downloadContentFromMessage(qVid, "video");

    const buffer = await streamToBuffer(stream);

    return {

      kind: "video",

      buffer,

      mimetype: qVid.mimetype || "video/mp4",

      caption: qVid.caption || "",

    };

  }

  const qAud = quotedMsg?.audioMessage;

  if (qAud) {

    const stream = await downloadContentFromMessage(qAud, "audio");

    const buffer = await streamToBuffer(stream);

    return {

      kind: "audio",

      buffer,

      mimetype: qAud.mimetype || "audio/mpeg",

      ptt: !!qAud.ptt,

    };

  }

  return null;

}

export default {

  name: "gcstatus",

  aliases: ["groupstatus", "gstatus"],

  category: "OWNER",

  description: "Post Group Status (text or reply to image/video/audio).",

  async execute(ctx) {

    const { sock, m, from, args } = ctx;

    if (!isPrivileged(ctx)) {

      return sock.sendMessage(from, { text: "❌ Owner/Sudo only." }, { quoted: m });

    }

    if (!from || !from.endsWith("@g.us")) {

      return sock.sendMessage(from, { text: "❌ This command works only in groups." }, { quoted: m });

    }

    const textArg = (args || []).join(" ").trim();

    const quoted = getQuotedMessage(m);

    // If no text and no quoted media -> show usage

    const quotedHasSupportedMedia =

      !!quoted?.imageMessage || !!quoted?.videoMessage || !!quoted?.audioMessage;

    if (!textArg && !quotedHasSupportedMedia) {

      return sock.sendMessage(

        from,

        {

          text:

            "reply to an image/video/audio or type a text\n" +

            "prefix(gcstatus <text>)",

        },

        { quoted: m }

      );

    }

    // Build inner message (the thing inside groupStatusMessageV2.message)

    let innerMessageContent = null;

    // If replied to media, post that media (optionally with caption from args)

    if (quotedHasSupportedMedia) {

      const media = await downloadQuotedMedia(quoted);

      if (!media) {

        return sock.sendMessage(

          from,

          {

            text:

              "❌ Unsupported reply type.\n" +

              "reply to an image/video/audio or type a text\n" +

              "prefix(gcstatus <text>)",

          },

          { quoted: m }

        );

      }

      if (media.kind === "image") {

        const prepared = await prepareWAMessageMedia(

          { image: media.buffer, mimetype: media.mimetype, caption: textArg || media.caption || "" },

          { upload: sock.waUploadToServer }

        );

        innerMessageContent = prepared;

      } else if (media.kind === "video") {

        const prepared = await prepareWAMessageMedia(

          { video: media.buffer, mimetype: media.mimetype, caption: textArg || media.caption || "" },

          { upload: sock.waUploadToServer }

        );

        innerMessageContent = prepared;

      } else if (media.kind === "audio") {

        const prepared = await prepareWAMessageMedia(

          { audio: media.buffer, mimetype: media.mimetype, ptt: media.ptt },

          { upload: sock.waUploadToServer }

        );

        innerMessageContent = prepared;

      }

    } else {

      // Text-only status

      innerMessageContent = {

        extendedTextMessage: {

          text: textArg,

          inviteLinkGroupTypeV2: "DEFAULT",

        },

      };

    }

    // Wrap into groupStatusMessageV2

    const messageContent = {

      groupStatusMessageV2: {

        message: innerMessageContent,

      },

    };

    const msg = generateWAMessageFromContent(

      from,

      proto.Message.fromObject(messageContent),

      { userJid: from }

    );

    await sock.relayMessage(from, msg.message, {

      additionalNodes: [{ tag: "meta", attrs: { is_group_status: "true" } }],

      messageId: msg.key.id,

    });

    return sock.sendMessage(from, { text: "✅ Group status posted." }, { quoted: m });

  },

};