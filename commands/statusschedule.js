// commands/autostatus.js
// Owner-only persistent automatic WhatsApp personal-status scheduler.

import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { isOwner } from "../checks/isOwner.js";
import {
  addAutoStatusSchedule,
  deleteAutoStatusSchedule,
  getAutoStatusContactsInfo,
  ensureOwnerInStatusContacts,
  listAutoStatusSchedules,
  runAutoStatusScheduleNow,
  setAutoStatusScheduleEnabled,
} from "../control/autoStatusScheduler.js";

function footer() {
  return "> POWERED BY BMEDIA";
}

function box(title, lines = []) {
  return [
    `╭─〔 ${title} 〕`,
    ...lines.map((line, i) => (i === lines.length - 1 ? `╰◦ ${line}` : `├◦ ${line}`)),
  ].join("\n");
}

function getContextInfo(m) {
  const msg = m?.message || {};
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.buttonsResponseMessage?.contextInfo ||
    msg.listResponseMessage?.contextInfo ||
    msg.templateButtonReplyMessage?.contextInfo ||
    null
  );
}

function getQuotedMessage(m) {
  return getContextInfo(m)?.quotedMessage || null;
}

function getQuotedMedia(quoted) {
  if (!quoted) return null;
  const wrappers = [
    quoted,
    quoted.viewOnceMessage?.message,
    quoted.viewOnceMessageV2?.message,
    quoted.viewOnceMessageV2Extension?.message,
  ].filter(Boolean);

  for (const q of wrappers) {
    if (q.imageMessage) return { type: "image", msg: q.imageMessage };
    if (q.videoMessage) return { type: "video", msg: q.videoMessage };
    if (q.audioMessage) return { type: "audio", msg: q.audioMessage };
  }
  return null;
}

function getQuotedText(quoted) {
  if (!quoted) return "";
  return String(
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    ""
  ).trim();
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadQuotedMedia(media) {
  const stream = await downloadContentFromMessage(media.msg, media.type);
  const buffer = await streamToBuffer(stream);
  return {
    type: media.type,
    buffer,
    mimetype: media.msg?.mimetype || "",
    ptt: Boolean(media.msg?.ptt),
  };
}

function formatRule(s) {
  if (s.repeat === "once") return `${s.date} ${s.time} (once)`;
  if (s.repeat === "daily") return `${s.time} (daily)`;
  return `${s.time} (${(s.days || []).join(",")})`;
}

function usage(prefix = ".") {
  return [
    box("AUTO STATUS", [
      `Add daily : ${prefix}statusschedule add Morning | 07:30 | daily | Good morning`,
      `Add weekly: ${prefix}statusschedule add Promo | 18:00 | mon,wed,fri | Promo text`,
      `Add once  : ${prefix}statusschedule add Launch | 2026-10-10 14:30 | once | Launch text`,
      `Media     : reply to image/video/audio and use the same add format`,
      `List      : ${prefix}statusschedule list`,
      `Delete    : ${prefix}statusschedule delete <name or id>`,
      `Pause     : ${prefix}statusschedule pause <name or id>`,
      `Resume    : ${prefix}statusschedule resume <name or id>`,
      `Run now   : ${prefix}statusschedule run <name or id>`,
      `Contacts  : ${prefix}statusschedule contacts`,
    ]),
    "",
    "contacts.vcf must be stored at assets/contacts.vcf",
    footer(),
  ].join("\n");
}

export default {
  name: "statusschedule",
  aliases: ["asc", "sschedule", "stschedule"],
  category: "OWNER",
  description: "Create, list, run, pause, resume, and delete named automatic personal-status schedules.",
  usage: "statusschedule <add|list|delete|pause|resume|run|contacts>",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = ".", senderJid, sender } = ctx;

    if (!isOwner({ senderJid: senderJid || sender })) {
      return sock.sendMessage(from, { text: "❌ Owner only." }, { quoted: m });
    }

    // Ensure the configured owner is always part of the VCF status audience.
    // This edits assets/contacts.vcf only when the owner number is not already present.
    const ownerContact = ensureOwnerInStatusContacts();

    const action = String(args[0] || "").trim().toLowerCase();
    if (!action || action === "help") {
      return sock.sendMessage(from, { text: usage(prefix) }, { quoted: m });
    }

    if (action === "contacts") {
      const info = getAutoStatusContactsInfo();
      const lines = info.exists
        ? [
            "VCF      : Found",
            `Contacts : ${info.count}`,
            `Owner    : ${ownerContact.ownerNumber ? (ownerContact.added ? "Added now" : "Included") : "OWNER_NUMBER missing"}`,
            "Path     : assets/contacts.vcf",
          ]
        : ["VCF      : Missing", "Path     : assets/contacts.vcf", `Reason   : ${info.error || "Unknown"}`];
      return sock.sendMessage(from, { text: `${box("AUTO STATUS CONTACTS", lines)}\n\n${footer()}` }, { quoted: m });
    }

    if (action === "list") {
      const schedules = listAutoStatusSchedules();
      if (!schedules.length) {
        return sock.sendMessage(from, { text: `${box("AUTO STATUS", ["No schedules saved."])}\n\n${footer()}` }, { quoted: m });
      }

      const lines = [];
      for (const [i, s] of schedules.entries()) {
        const state = s.completed ? "COMPLETED" : s.enabled ? "ACTIVE" : "PAUSED";
        lines.push(
          `${i + 1}. ${s.name}`,
          `   ID: ${s.id} | ${state}`,
          `   ${formatRule(s)} | ${s.type}`,
          s.lastSentAt ? `   Last: ${s.lastSentAt}` : "   Last: never"
        );
      }
      return sock.sendMessage(from, { text: `${box("AUTO STATUS SCHEDULES", lines)}\n\n${footer()}` }, { quoted: m });
    }

    if (["delete", "del", "remove"].includes(action)) {
      const query = args.slice(1).join(" ").trim();
      if (!query) return sock.sendMessage(from, { text: `Usage: ${prefix}statusschedule delete <name or id>` }, { quoted: m });
      const removed = deleteAutoStatusSchedule(query);
      if (!removed) return sock.sendMessage(from, { text: `❌ Schedule not found: ${query}` }, { quoted: m });
      return sock.sendMessage(
        from,
        { text: `${box("AUTO STATUS DELETED", [`Name : ${removed.name}`, `ID   : ${removed.id}`])}\n\n${footer()}` },
        { quoted: m }
      );
    }

    if (["pause", "off"].includes(action)) {
      const query = args.slice(1).join(" ").trim();
      if (!query) return sock.sendMessage(from, { text: `Usage: ${prefix}statusschedule pause <name or id>` }, { quoted: m });
      const updated = setAutoStatusScheduleEnabled(query, false);
      if (!updated) return sock.sendMessage(from, { text: `❌ Schedule not found: ${query}` }, { quoted: m });
      return sock.sendMessage(from, { text: `⏸️ Paused: ${updated.name}` }, { quoted: m });
    }

    if (["resume", "on"].includes(action)) {
      const query = args.slice(1).join(" ").trim();
      if (!query) return sock.sendMessage(from, { text: `Usage: ${prefix}statusschedule resume <name or id>` }, { quoted: m });
      const updated = setAutoStatusScheduleEnabled(query, true);
      if (!updated) return sock.sendMessage(from, { text: `❌ Schedule not found: ${query}` }, { quoted: m });
      return sock.sendMessage(from, { text: `▶️ Resumed: ${updated.name}` }, { quoted: m });
    }

    if (["run", "test", "now"].includes(action)) {
      const query = args.slice(1).join(" ").trim();
      if (!query) return sock.sendMessage(from, { text: `Usage: ${prefix}statusschedule run <name or id>` }, { quoted: m });
      try {
        const result = await runAutoStatusScheduleNow(sock, query);
        if (!result) return sock.sendMessage(from, { text: `❌ Schedule not found: ${query}` }, { quoted: m });
        return sock.sendMessage(
          from,
          { text: `${box("AUTO STATUS POSTED", [`Name  : ${result.schedule.name}`, `Reach : ${result.recipients} contact(s)`])}\n\n${footer()}` },
          { quoted: m }
        );
      } catch (error) {
        return sock.sendMessage(from, { text: `❌ Scheduled status test failed.\n${error?.message || error}` }, { quoted: m });
      }
    }

    if (action === "add" || action === "create") {
      const raw = args.slice(1).join(" ").trim();
      const fields = raw.split("|").map((x) => x.trim());
      const [name, when, repeat, typedContent = ""] = fields;

      if (!name || !when || !repeat) {
        return sock.sendMessage(from, { text: usage(prefix) }, { quoted: m });
      }

      const quoted = getQuotedMessage(m);
      const quotedMedia = getQuotedMedia(quoted);
      const quotedText = getQuotedText(quoted);

      try {
        let media = null;
        if (quotedMedia) media = await downloadQuotedMedia(quotedMedia);

        const schedule = addAutoStatusSchedule({
          name,
          when,
          repeat,
          text: media ? "" : (typedContent || quotedText),
          media,
          caption: media ? (typedContent || quotedText) : "",
        });

        const contacts = getAutoStatusContactsInfo();
        return sock.sendMessage(
          from,
          {
            text: [
              box("AUTO STATUS SAVED", [
                `Name     : ${schedule.name}`,
                `ID       : ${schedule.id}`,
                `Schedule : ${formatRule(schedule)}`,
                `Type     : ${schedule.type}`,
                `Timezone : ${schedule.timezone}`,
                `Audience : ${contacts.exists ? `${contacts.count} VCF contact(s)` : "contacts.vcf missing"}`,
              ]),
              "",
              "The schedule is persistent and can be deleted at any time by name or ID.",
              footer(),
            ].join("\n"),
          },
          { quoted: m }
        );
      } catch (error) {
        return sock.sendMessage(from, { text: `❌ Could not create schedule.\n${error?.message || error}` }, { quoted: m });
      }
    }

    return sock.sendMessage(from, { text: usage(prefix) }, { quoted: m });
  },
};
