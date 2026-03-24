// commands/mute.js (ESM)

// Admin-only: closes the group (only admins can send messages)

// Usage:

//   <prefix>mute

//   <prefix>mute 30   (minutes)

// Reply (tags using your AntiLink method):

//   🔇 @admin muted the group

//   ⏳ @admin muted the group for 30 minutes

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

    return Boolean(me?.admin); // admin or superadmin

  } catch {

    return false;

  }

}

function sleep(ms) {

  return new Promise((r) => setTimeout(r, ms));

}

export default {

  name: "mute",

  aliases: ["close", "lock"],

  category: "GROUP",

  description: "Mute (close) a group. Admin only.",

  async execute(ctx) {

    const { sock, m, from, args, senderJid, prefix } = ctx;

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

    // minutes optional

    const minutes = args?.[0] ? parseInt(args[0], 10) : NaN;

    // close group

    try {

      await sock.groupSettingUpdate(from, "announcement"); // only admins can send

    } catch (e) {

      const msg = String(e?.message || e);

      return sock.sendMessage(from, { text: `❌ Failed: ${msg}` }, { quoted: m });

    }

    const tag = `@${sender.split("@")[0].split(":")[0]}`;

    if (Number.isFinite(minutes) && minutes > 0) {

      // Inform + schedule auto-unmute (in-memory; restarts clear it)

      await sock.sendMessage(

        from,

        {

          text: `⏳ ${tag} muted the group for *${minutes}* minute(s) 🔇`,

          mentions: [sender],

        },

        { quoted: m }

      ).catch(() => {});

      // auto unmute in background (best-effort)

      (async () => {

        await sleep(minutes * 60_000);

        try {

          await sock.groupSettingUpdate(from, "not_announcement"); // open

          await sock.sendMessage(from, { text: `🔊 Auto-unmute done after ${minutes} minute(s).` });

        } catch {}

      })();

      return;

    }

    return sock.sendMessage(

      from,

      {

        text: `🔇 ${tag} muted the group`,

        mentions: [sender],

      },

      { quoted: m }

    );

  },

};