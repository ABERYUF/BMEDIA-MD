export default {
  name: "help",
  aliases: [],
  category: "INFO",
  description: "Alias for menu.",
  async execute(ctx) {
    const { sock, m, from } = ctx;
    return sock.sendMessage(from, { text: `✅ help executed.` }, { quoted: m });
  }
};
