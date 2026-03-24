// commands/bible.js (ESM)

// Usage:

//   bible John 3:16

//   bible John 3:16-18

//   bible 1 John 3:16-18

//   bible john+3:16-18

export default {

  name: "bible",

  aliases: ["verse", "scripture"],

  category: "UTILITY",

  description: "Fetch Bible verse(s) by reference (DavidCyril API).",

  async execute(ctx) {

    const { sock, m, from, args = [] } = ctx;

    const base = "https://apis.davidcyril.name.ng/bible?reference=";

    const input = args.join(" ").trim();

    if (!input) {

      return sock

        .sendMessage(

          from,

          {

            text:

              "Usage:\n" +

              "• bible <Book> <Chapter:Verse>\n" +

              "• bible <Book> <Chapter:Verse-Verse>\n\n" +

              "Examples:\n" +

              "bible John 3:16\n" +

              "bible John 3:16-18\n" +

              "bible 1 John 3:16-18",

          },

          { quoted: m }

        )

        .catch(() => {});

    }

    // Normalize:

    // - allow inputs like "John (3:16-18)" or "John 3:16-18"

    // - remove surrounding parentheses

    // - spaces -> '+'

    const normalized = input

      .replace(/[()]/g, "")

      .replace(/\s+/g, " ")

      .trim()

      .replace(/ /g, "+");

    const url = base + encodeURIComponent(normalized);

    try {

      await sock.sendMessage(from, { react: { text: "📖", key: m.key } }).catch(() => {});

      const res = await fetch(url, { headers: { Accept: "application/json" } });

      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const data = await res.json().catch(() => null);

      if (!data?.success) throw new Error(data?.message || "Invalid response from API.");

      const ref = data.reference || input;

      const translation = data.translation || "Unknown";

      const count = Number.isFinite(data.verses_count) ? data.verses_count : null;

      const body = String(data.text || "").trim();

      const header =

        `📖 *${ref}*\n` +

        `_${translation}_` +

        (count !== null ? ` • *${count}* verse${count === 1 ? "" : "s"}` : "");

      const msg = `${header}\n\n${body || "No text returned."}`;

      // Safety: WhatsApp message length limits

      const safeMsg = msg.length > 6500 ? msg.slice(0, 6500) + "\n…(truncated)" : msg;

      await sock.sendMessage(from, { text: safeMsg }, { quoted: m });

      await sock.sendMessage(from, { react: { text: "✅", key: m.key } }).catch(() => {});

    } catch (e) {

      await sock

        .sendMessage(

          from,

          { text: `❌ Bible lookup failed.\nReason: ${e?.message || "unknown error"}` },

          { quoted: m }

        )

        .catch(() => {});

    }

  },

};