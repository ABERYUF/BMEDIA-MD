// commands/filtervcf.js
// BMEDIA-MD VCF filter
// Usage (reply to a .vcf document):
//   .filtervcf whatsapp  -> keep only numbers confirmed to be on WhatsApp
//   .filtervcf valid     -> keep only syntactically valid phone numbers
//
// Owner-only because WhatsApp registration checks should not be exposed as a public bulk lookup tool.

import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { isOwner } from "../checks/isOwner.js";

const MAX_WHATSAPP_CHECKS = 2000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 900;
const RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function footer() {
  return "> POWERED BY BMEDIA";
}

function getContextInfo(m) {
  const msg = m?.message || {};
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
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

function unwrapQuotedDocument(quoted) {
  if (!quoted) return null;

  if (quoted.documentMessage) return quoted.documentMessage;
  if (quoted.documentWithCaptionMessage?.message?.documentMessage) {
    return quoted.documentWithCaptionMessage.message.documentMessage;
  }
  if (quoted.viewOnceMessage?.message?.documentMessage) {
    return quoted.viewOnceMessage.message.documentMessage;
  }
  if (quoted.viewOnceMessageV2?.message?.documentMessage) {
    return quoted.viewOnceMessageV2.message.documentMessage;
  }
  if (quoted.viewOnceMessageV2Extension?.message?.documentMessage) {
    return quoted.viewOnceMessageV2Extension.message.documentMessage;
  }

  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function downloadQuotedDocument(doc) {
  const stream = await downloadContentFromMessage(doc, "document");
  return streamToBuffer(stream);
}

function unfoldVcardLines(card) {
  const raw = String(card || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];

  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }

  return out;
}

function splitVcards(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cards = normalized.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];
  return cards;
}

function extractTelValue(line) {
  const idx = String(line || "").indexOf(":");
  if (idx < 0) return "";
  let value = String(line.slice(idx + 1) || "").trim();

  // vCard 4 / URI style: TEL;VALUE=uri:tel:+237...
  value = value.replace(/^tel:/i, "");

  // Ignore extension/post-dial parts for WhatsApp registration checks.
  value = value.split(/[;,](?:ext|extension|isub|postd)=/i)[0].trim();

  return value;
}

function normalizePhone(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";

  // Remove common international dialing prefix.
  if (raw.startsWith("00")) raw = raw.slice(2);

  // Keep digits only after handling an optional leading +.
  return raw.replace(/[^\d]/g, "");
}

function isStructurallyValidNumber(digits) {
  // E.164 max is 15 digits. We use 7 as a practical lower bound for international/mobile numbers.
  return /^\d{7,15}$/.test(String(digits || ""));
}

function jidToDigits(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/[^\d]/g, "");
}

function safeBaseName(name = "contacts.vcf") {
  const clean = String(name || "contacts.vcf").replace(/[^\w.\-]+/g, "_");
  return clean.toLowerCase().endsWith(".vcf") ? clean.slice(0, -4) : clean;
}

async function queryWhatsAppBatch(sock, numbers) {
  const jids = numbers.map((n) => `${n}@s.whatsapp.net`);

  let lastError = null;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const result = await sock.onWhatsApp(...jids);

      if (!Array.isArray(result)) {
        throw new Error("WhatsApp lookup returned an unexpected response.");
      }

      const found = new Set();

      for (const item of result) {
        if (!item?.exists) continue;
        const digits = jidToDigits(item?.jid || "");
        if (digits) found.add(digits);
      }

      return found;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await sleep(800 * attempt);
    }
  }

  throw new Error(
    `WhatsApp registration check failed after ${RETRIES} attempts: ${lastError?.message || lastError}`
  );
}

async function getRegisteredWhatsAppNumbers(sock, numbers) {
  const unique = [...new Set(numbers)];
  if (unique.length > MAX_WHATSAPP_CHECKS) {
    throw new Error(
      `This VCF contains ${unique.length} unique numbers. Maximum per run is ${MAX_WHATSAPP_CHECKS}. Split the file and run the command again.`
    );
  }

  const registered = new Set();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const found = await queryWhatsAppBatch(sock, batch);
    for (const number of found) registered.add(number);

    if (i + BATCH_SIZE < unique.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return registered;
}

function collectNumbers(cards) {
  const numbers = [];

  for (const card of cards) {
    const lines = unfoldVcardLines(card);
    for (const line of lines) {
      if (!/^TEL(?:;[^:]*)?:/i.test(line)) continue;
      const digits = normalizePhone(extractTelValue(line));
      if (isStructurallyValidNumber(digits)) numbers.push(digits);
    }
  }

  return [...new Set(numbers)];
}

function filterCards(cards, keepNumber) {
  const seen = new Set();
  const outputCards = [];

  let cardsRemoved = 0;
  let numbersRemoved = 0;
  let duplicatesRemoved = 0;
  let numbersKept = 0;

  for (const card of cards) {
    const lines = unfoldVcardLines(card);
    const keptLines = [];
    let keptTelCount = 0;
    let hadTel = false;

    for (const line of lines) {
      if (!/^TEL(?:;[^:]*)?:/i.test(line)) {
        keptLines.push(line);
        continue;
      }

      hadTel = true;

      const digits = normalizePhone(extractTelValue(line));

      if (!isStructurallyValidNumber(digits)) {
        numbersRemoved++;
        continue;
      }

      if (!keepNumber(digits)) {
        numbersRemoved++;
        continue;
      }

      if (seen.has(digits)) {
        duplicatesRemoved++;
        continue;
      }

      seen.add(digits);
      keptLines.push(line);
      keptTelCount++;
      numbersKept++;
    }

    // A contact without any surviving TEL line is not useful in a filtered contacts VCF.
    if (hadTel && keptTelCount === 0) {
      cardsRemoved++;
      continue;
    }

    // Cards containing no TEL field are also removed.
    if (!hadTel) {
      cardsRemoved++;
      continue;
    }

    // Normalize output to CRLF, which is standard for vCard files.
    outputCards.push(keptLines.join("\r\n"));
  }

  return {
    text: outputCards.length ? `${outputCards.join("\r\n")}\r\n` : "",
    cardsKept: outputCards.length,
    cardsRemoved,
    numbersKept,
    numbersRemoved,
    duplicatesRemoved,
  };
}

function summaryCaption(mode, originalCards, stats) {
  const label = mode === "whatsapp" ? "WHATSAPP FILTER" : "VALID NUMBER FILTER";
  return [
    `✅ ${label} COMPLETE`,
    "",
    `Contacts scanned: ${originalCards}`,
    `Contacts kept: ${stats.cardsKept}`,
    `Contacts removed: ${stats.cardsRemoved}`,
    `Numbers kept: ${stats.numbersKept}`,
    `Numbers removed: ${stats.numbersRemoved}`,
    `Duplicates removed: ${stats.duplicatesRemoved}`,
    "",
    footer(),
  ].join("\n");
}

export default {
  name: "filtervcf",
  aliases: ["fvcf"],
  category: "OWNER",
  description: "Filter a replied VCF by WhatsApp registration or phone-number validity.",
  usage: "filtervcf whatsapp | filtervcf valid",

  async execute(ctx) {
    const { sock, m, from, args = [], prefix = "." } = ctx;
    const senderJid =
      ctx?.senderJid ||
      ctx?.sender ||
      m?.key?.participant ||
      m?.key?.remoteJid ||
      "";

    if (!isOwner({ senderJid })) {
      return sock.sendMessage(from, { text: "❌ Owner only." }, { quoted: m });
    }

    const mode = String(args[0] || "").trim().toLowerCase();

    if (!["whatsapp", "valid"].includes(mode)) {
      return sock.sendMessage(
        from,
        {
          text: [
            "╭─〔 FILTER VCF 〕",
            `├◦ Reply to a .vcf file with ${prefix}filtervcf whatsapp`,
            `├◦ WhatsApp: removes numbers not registered on WhatsApp`,
            `├◦ Reply with ${prefix}filtervcf valid`,
            "╰◦ Valid: removes malformed/invalid phone numbers and duplicates",
            "",
            footer(),
          ].join("\n"),
        },
        { quoted: m }
      );
    }

    const quoted = getQuotedMessage(m);
    const doc = unwrapQuotedDocument(quoted);

    if (!doc) {
      return sock.sendMessage(
        from,
        {
          text: `❌ Reply to a .vcf contact file with:\n${prefix}filtervcf ${mode}`,
        },
        { quoted: m }
      );
    }

    const fileName = String(doc.fileName || "contacts.vcf");
    const mimetype = String(doc.mimetype || "").toLowerCase();

    const looksLikeVcf =
      fileName.toLowerCase().endsWith(".vcf") ||
      mimetype.includes("vcard") ||
      mimetype.includes("x-vcard");

    if (!looksLikeVcf) {
      return sock.sendMessage(
        from,
        { text: "❌ The replied document does not look like a .vcf/vCard file." },
        { quoted: m }
      );
    }

    try {
      const buffer = await downloadQuotedDocument(doc);

      if (!buffer?.length) {
        throw new Error("The replied VCF could not be downloaded.");
      }

      // VCF is overwhelmingly UTF-8 today; stripping a BOM also handles common exports.
      const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
      const cards = splitVcards(text);

      if (!cards.length) {
        throw new Error("No BEGIN:VCARD / END:VCARD contacts were found.");
      }

      const allNumbers = collectNumbers(cards);

      if (!allNumbers.length) {
        throw new Error("No usable phone numbers were found in the VCF.");
      }

      await sock.sendMessage(
        from,
        {
          text:
            mode === "whatsapp"
              ? `🔎 Checking ${allNumbers.length} unique number(s) against WhatsApp...\nThis is rate-limited to protect the account.`
              : `🔎 Validating ${allNumbers.length} unique phone number(s)...`,
        },
        { quoted: m }
      );

      let result;

      if (mode === "whatsapp") {
        if (typeof sock.onWhatsApp !== "function") {
          throw new Error("This Baileys socket does not expose onWhatsApp().");
        }

        const registered = await getRegisteredWhatsAppNumbers(sock, allNumbers);
        result = filterCards(cards, (digits) => registered.has(digits));
      } else {
        result = filterCards(cards, () => true);
      }

      if (!result.text.trim()) {
        return sock.sendMessage(
          from,
          {
            text:
              mode === "whatsapp"
                ? "❌ No confirmed WhatsApp contacts remained after filtering."
                : "❌ No valid contacts remained after filtering.",
          },
          { quoted: m }
        );
      }

      const base = safeBaseName(fileName);
      const outName =
        mode === "whatsapp"
          ? `${base}-whatsapp-filtered.vcf`
          : `${base}-valid-filtered.vcf`;

      return sock.sendMessage(
        from,
        {
          document: Buffer.from(result.text, "utf8"),
          mimetype: "text/vcard",
          fileName: outName,
          caption: summaryCaption(mode, cards.length, result),
        },
        { quoted: m }
      );
    } catch (error) {
      return sock.sendMessage(
        from,
        {
          text: `❌ VCF filter failed.\nReason: ${error?.message || error}`,
        },
        { quoted: m }
      );
    }
  },
};
