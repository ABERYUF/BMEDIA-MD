const { escapeHtml } = require('../lib/helpers');
const bmc = require('../lib/bmcStore');

function footerHtml(url) {
  const href = String(url || '').trim();
  return href
    ? `<a href="${href.replace(/"/g, '&quot;')}"><b>✦ POWERED BY BMEDIA ✦</b></a>`
    : '<b>✦ POWERED BY BMEDIA ✦</b>';
}

function inviteKeyboard(link, services) {
  const rows = [
    [{
      text: '📤 Share Invite',
      url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join BMEDIA Bot. Pair BMEDIA-MD, earn BMC through referrals, and use BMC for group services such as AntiLink.')}`,
      style: 'primary',
    }],
    [
      { text: '📋 Copy Invite Link', copy_text: { text: link }, style: 'success' },
      { text: '💰 Balance', callback_data: 'bmedia_balance', style: 'primary' },
    ],
    [{ text: '🛡 AntiLink', callback_data: 'bmedia_antilink', style: 'success' }],
    [{ text: '📋 Main Menu', callback_data: 'bmedia_menu', style: 'primary' }],
  ];
  if (services.tutorialUrl) rows.push([{ text: '🎬 Free Deployment Tutorial', url: services.tutorialUrl }]);
  return { reply_markup: { inline_keyboard: rows } };
}

module.exports = {
  category: 'ACCOUNT',
  name: 'invite',
  aliases: ['invitecenter', 'referral', 'refer'],
  description: 'Open Invite Center and earn BMC',
  async run(ctx, services) {
    try {
      if (ctx.chat?.type !== 'private') {
        const me = ctx.botInfo || await ctx.telegram.getMe();
        return ctx.reply('🔒 Open Invite Center in private chat so your personal referral link is not posted publicly.', {
          reply_markup: {
            inline_keyboard: [[{ text: '👥 Open Invite Center', url: `https://t.me/${me.username}?start=earn`, style: 'success' }]],
          },
        });
      }

      const user = await bmc.ensureUser(ctx);
      const me = ctx.botInfo || await ctx.telegram.getMe();
      const botUsername = String(me?.username || '').trim();
      if (!botUsername) throw new Error('Bot username is unavailable.');

      const link = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
      const text = [
        '╭─〔 <b>INVITE CENTER</b> 〕',
        `├◦ Your ID: <code>${escapeHtml(String(ctx.from.id))}</code>`,
        `├◦ Successful invites: <b>${Number(user?.totalInvites || 0)}</b>`,
        `├◦ Balance: <b>${Number(user?.balanceBmc || 0)} BMC</b>`,
        '├◦ Reward: <b>1 BMC per new user</b>',
        '╰◦ 1 BMC = 30 days of AntiLink for one group',
        '',
        `<code>${escapeHtml(link)}</code>`,
        '',
        footerHtml(services.brandUrl),
      ].join('\n');

      return ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...inviteKeyboard(link, services),
      });
    } catch (e) {
      return ctx.reply(`❌ <b>INVITE CENTER ERROR</b>\n\n<code>${escapeHtml(e.message || String(e))}</code>`, { parse_mode: 'HTML' });
    }
  },
};
