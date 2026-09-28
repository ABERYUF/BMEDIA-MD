const fs = require('fs');
const path = require('path');

function footerHtml(url) {
  const href = String(url || '').trim();
  return href
    ? `<a href="${href.replace(/"/g, '&quot;')}"><b>✦ POWERED BY BMEDIA ✦</b></a>`
    : '<b>✦ POWERED BY BMEDIA ✦</b>';
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🔗 Pair WhatsApp' }, { text: '🛡 AntiLink' }],
        [{ text: '👥 Invite Center' }, { text: '💰 Balance' }],
        [{ text: '🎓 BMEDIA Premium' }, { text: '💬 Contact Admin' }],
        [{ text: '🆔 My ID' }, { text: '📋 Menu' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Choose an option or type a command…',
    },
  };
}

function menuText(brandUrl) {
  return [
    '┌──────────────────',
    '│ <b>BMEDIA BOT MENU</b>',
    '└──────────────────',
    '',
    '┌──────────────────',
    '│ <b>「 ACCOUNT 」</b>',
    '├──────────────────',
    '│ ✺ /invite',
    '│ ✺ /balance',
    '│ ✺ /id',
    '└──────────────────',
    '',
    '┌──────────────────',
    '│ <b>「 WHATSAPP PAIRING 」</b>',
    '├──────────────────',
    '│ ✺ /pair',
    '└──────────────────',
    '',
    '┌──────────────────',
    '│ <b>「 GROUP PROTECTION 」</b>',
    '├──────────────────',
    '│ ✺ /antilink',
    '│ ✺ /antilink activate',
    '│ ✺ /antilink renew',
    '│ ✺ /antilink on | off',
    '└──────────────────',
    '',
    '┌──────────────────',
    '│ <b>「 TUTORIALS 」</b>',
    '├──────────────────',
    '│ ✺ /tutorials  · free + premium',
    '│ ✺ /contact',
    '│ ✺ /menu',
    '└──────────────────',
    '',
    footerHtml(brandUrl),
  ].join('\n');
}

module.exports = {
  category: 'NAVIGATION',
  name: 'menu',
  aliases: ['help', 'commands'],
  description: 'Show BMEDIA Telegram bot menu',
  async run(ctx, services) {
    const caption = menuText(services.brandUrl);
    const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      return ctx.replyWithPhoto({ source: logoPath }, {
        caption,
        parse_mode: 'HTML',
        ...mainKeyboard(),
      });
    }
    return ctx.reply(caption, { parse_mode: 'HTML', ...mainKeyboard() });
  },
  menuText,
  mainKeyboard,
};
