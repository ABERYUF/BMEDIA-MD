// commands/unmute.js (ESM)

// Admin-only: opens the group (everyone can send messages)

// Usage: <prefix>unmute

// Reply (tags using your AntiLink method):

//   🔊 @admin unmuted the group

function pickSender(m, senderJid) {

  return m?.key?.participant || m?.participant || m?.sender || senderJid || "";

}

function bare(id) {

  return String(id || "").split("@")[0].split(":")[0];

}

async function isAdmin(sock, groupJid, sender) {

  try {

    const meta = await sock.groupMetadata(groupJid);

    const sb = bare(sender);

    const me = (meta.participants || []).find((p) => bare(p.id) === sb);

    return Boolean(me?.admin);

  } catch {

    return false;

  }

}

export default {

  name: "unmute",

  aliases: ["open", "unlock"],

  category: "GROUP",

  description: "Unmute (open) a group. Admin only.",

  async execute(ctx) {

    const { sock, m, from, senderJid } = ctx;

    if (!from?.endsWith("@g.us")) {

      return sock.sendMessage(from, { text: "This command works in groups only." }, { quoted: m });

    }

    const sender = pickSender(m, senderJid);

    if (!sender) return;

    // ✅ Admin only

    const adminOk = await isAdmin(sock, from, sender);

    if (!adminOk) {

      return sock.sendMessage(from, { text: "❌ Admin only." }, { quoted: m });

    }

    try {

      await sock.groupSettingUpdate(from, "not_announcement"); // open group

    } catch (e) {

      const msg = String(e?.message || e);

      return sock.sendMessage(from, { text: `❌ Failed: ${msg}` }, { quoted: m });

    }

    const tag = `@${sender.split("@")[0].split(":")[0]}`;

    return sock.sendMessage(

      from,

      {

        text: `🔊 ${tag} unmuted the group`,

        mentions: [sender],

      },

      { quoted: m }

    );

  },

};