const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const bmcStore = require('./lib/bmcStore');
const { escapeHtml } = require('./lib/helpers');

function footerHtml(url) {
  const href = String(url || '').trim();
  return href ? `<a href="${href.replace(/"/g, '&quot;')}"><b>✦ POWERED BY BMEDIA ✦</b></a>` : '<b>✦ POWERED BY BMEDIA ✦</b>';
}

function parsePremiumTutorials(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => ({ title: String(item?.title || '').trim(), url: String(item?.url || '').trim() }))
      .filter(item => item.url && /^https?:\/\//i.test(item.url));
  } catch {
    return [];
  }
}

function persistentMenuKeyboard() {
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

function startText(brandUrl) {
  return [
    '╭─〔 <b>BMEDIA MASTER BOT</b> 〕',
    '├◦ Pair BMEDIA-MD with WhatsApp',
    '├◦ Protect Telegram groups with AntiLink',
    '├◦ Refer new users and earn BMC',
    '╰◦ Choose an option below',
    '',
    footerHtml(brandUrl),
  ].join('\n');
}

function loadCommandModules(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...loadCommandModules(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const mod = require(full);
      if (mod?.name && typeof mod.run === 'function') out.push(mod);
    }
  }
  return out;
}

async function callModule(map, name, ctx, services) {
  const mod = map.get(name);
  if (mod) return mod.run(ctx, services);
}

function referralDisplayName(result) {
  const invitee = result?.invitee || {};
  if (invitee.username) return `@${escapeHtml(invitee.username)}`;
  const full = [invitee.firstName, invitee.lastName].filter(Boolean).join(' ').trim();
  if (full) return `<b>${escapeHtml(full)}</b>`;
  return `<code>${escapeHtml(invitee.telegramUserId || 'new user')}</code>`;
}

async function startTelegramBot({ port }) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN is empty; Telegram bot disabled.');
    return null;
  }

  const commandsDir = path.join(__dirname, 'commands');
  const modules = loadCommandModules(commandsDir);

  const map = new Map();
  for (const mod of modules) {
    for (const n of [mod.name, ...(mod.aliases || [])]) map.set(String(n).toLowerCase(), mod);
  }

  let adminUrl = String(process.env.CONTACT_ADMIN_URL || '').trim();
  const adminUsername = String(process.env.TELEGRAM_ADMIN_USERNAME || '').trim().replace(/^@/, '');
  if (!adminUrl && adminUsername) adminUrl = `https://t.me/${adminUsername}`;

  const services = {
    config: { footer: process.env.TELEGRAM_FOOTER || 'POWERED BY BMEDIA' },
    tutorialUrl: String(process.env.DEPLOYMENT_TUTORIAL_URL || 'https://youtu.be/Pr9FS8jwGPk?si=6Sd29EMwTtoe7RVy').trim(),
    brandUrl: String(process.env.YOUTUBE_CHANNEL_URL || process.env.CHANNEL_URL || 'https://www.youtube.com/@bmedia-md').trim(),
    youtubeSubscribeUrl: String(process.env.YOUTUBE_SUBSCRIBE_URL || process.env.YOUTUBE_CHANNEL_URL || 'https://www.youtube.com/@bmedia-md').trim(),
    youtubeChannelName: String(process.env.YOUTUBE_CHANNEL_NAME || 'BMEDIA-MD').trim(),
    youtubeChannelHandle: String(process.env.YOUTUBE_CHANNEL_HANDLE || '@bmedia-md').trim(),
    youtubeVerifyPhrase: String(process.env.YOUTUBE_VERIFY_PHRASE || 'DZL4').trim(),
    ocrSpaceApiKey: String(process.env.OCR_SPACE_API_KEY || '').trim(),
    premiumTutorials: parsePremiumTutorials(process.env.PREMIUM_TUTORIALS_JSON),
    adminUrl,
    pairingBaseUrl: `http://127.0.0.1:${port}`,
    botUsername: '',
  };

  const bot = new Telegraf(token);
  const botInfo = await bot.telegram.getMe().catch(() => null);
  services.botUsername = String(botInfo?.username || '').trim();

  const botCommands = [
    { command: 'start', description: 'Start BMEDIA Master Bot' },
    { command: 'menu', description: 'Open main menu' },
    { command: 'pair', description: 'Pair your WhatsApp number' },
    { command: 'antilink', description: 'Protect a Telegram group' },
    { command: 'invite', description: 'Refer users and earn BMC' },
    { command: 'balance', description: 'Check your BMC wallet' },
    { command: 'id', description: 'Show your Telegram ID' },
    { command: 'tutorials', description: 'Free & premium tutorials' },
  ];

  await bot.telegram.setMyCommands(botCommands).catch(() => {});
  try {
    if (typeof bot.telegram.setChatMenuButton === 'function') {
      await bot.telegram.setChatMenuButton({ type: 'commands' });
    }
  } catch (e) {
    console.warn('[telegram] could not set chat menu button:', e?.message || e);
  }

  // Moderate group messages before normal command routing. Commands are not links,
  // and group admins are exempt inside the AntiLink module.
  const antiLinkMod = map.get('antilink');
  if (antiLinkMod?.moderateMessage) {
    bot.use(async (ctx, next) => {
      if (ctx.message) {
        const removed = await antiLinkMod.moderateMessage(ctx, services).catch(e => {
          console.warn('[antilink] moderation:', e?.message || e);
          return false;
        });
        if (removed) return;
      }
      return next();
    });
  }

  bot.start(async ctx => {
    await bmcStore.ensureUser(ctx).catch(e => console.warn('[bmc] ensure user:', e?.message || e));

    const payload = String(ctx.startPayload || '').trim();

    // startgroup deep-link: show the activation panel inside the selected group.
    if (['group', 'supergroup'].includes(ctx.chat?.type) && payload === 'antilink') {
      return callModule(map, 'antilink', ctx, services);
    }

    const ref = payload.match(/^ref_(\d+)$/);
    if (ref) {
      const result = await bmcStore.processReferral(ctx, ref[1]).catch(e => {
        console.warn('[bmc] referral:', e?.message || e);
        return { rewarded: false };
      });

      if (result.rewarded) {
        await ctx.reply('🎉 <b>Referral accepted.</b> Your inviter received <b>1 BMC</b>.', { parse_mode: 'HTML' }).catch(() => {});
        await bot.telegram.sendMessage(
          result.referrerId,
          [
            '🎉 <b>NEW REFERRAL</b>',
            '',
            `${referralDisplayName(result)} joined using your referral link.`,
            'Reward: <b>+1 BMC</b>',
            `New balance: <b>${Number(result.referrerBalance || 0)} BMC</b>`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        ).catch(e => console.warn('[bmc] referrer notification:', e?.message || e));
      }
    }

    // Private deep-links used by AntiLink and wallet buttons.
    if (ctx.chat?.type === 'private' && payload === 'earn') return callModule(map, 'invite', ctx, services);
    if (ctx.chat?.type === 'private' && payload === 'balance') return callModule(map, 'balance', ctx, services);
    if (ctx.chat?.type === 'private' && payload === 'antilink') return callModule(map, 'antilink', ctx, services);
    if (ctx.chat?.type === 'private' && payload === 'premium') return callModule(map, 'tutorial', ctx, services);

    return ctx.reply(startText(services.brandUrl), {
      parse_mode: 'HTML',
      ...persistentMenuKeyboard(),
    });
  });

  bot.action('bmedia_pair', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return callModule(map, 'pair', ctx, services);
  });

  bot.action('bmedia_menu', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return callModule(map, 'menu', ctx, services);
  });

  bot.action('bmedia_invite', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return callModule(map, 'invite', ctx, services);
  });

  bot.action('bmedia_balance', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return callModule(map, 'balance', ctx, services);
  });

  bot.action('bmedia_antilink', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return callModule(map, 'antilink', ctx, services);
  });

  bot.action(/^bmedia_antilink_(activate|renew|on|off)$/, async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const action = ctx.match?.[1];
    if (antiLinkMod?.action && action) return antiLinkMod.action(ctx, services, action);
  });

  const tutorialMod = map.get('tutorial');
  bot.action(/^bmedia_premium_(verify|library)$/, async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const action = ctx.match?.[1];
    if (tutorialMod?.action && action) return tutorialMod.action(ctx, services, action);
  });

  bot.on('photo', async ctx => {
    await bmcStore.ensureUser(ctx).catch(() => {});
    if (tutorialMod?.onPhoto) await tutorialMod.onPhoto(ctx, services);
  });

  bot.on('document', async ctx => {
    await bmcStore.ensureUser(ctx).catch(() => {});
    if (tutorialMod?.onDocument) await tutorialMod.onDocument(ctx, services);
  });

  bot.on('text', async ctx => {
    await bmcStore.ensureUser(ctx).catch(() => {});
    const text = ctx.message?.text || '';
    if (!text.startsWith('/')) {
      const label = text.trim();
      const buttonRoutes = {
        '🔗 Pair WhatsApp': 'pair',
        '🛡 AntiLink': 'antilink',
        '👥 Invite Center': 'invite',
        '💰 Balance': 'balance',
        '🎓 BMEDIA Premium': 'tutorial',
        '🎬 Tutorials': 'tutorial',
        '💬 Contact Admin': 'contact',
        '🆔 My ID': 'id',
        '📋 Menu': 'menu',
        '❓ Help': 'menu',
      };
      const route = buttonRoutes[label];
      if (route) return callModule(map, route, ctx, services);

      for (const mod of modules) {
        if (typeof mod.onText === 'function' && await mod.onText(ctx, services)) return;
      }
      return;
    }

    const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?/);
    if (!m) return;
    const mod = map.get(m[1].toLowerCase());
    if (mod) await mod.run(ctx, services);
  });

  bot.catch(err => console.error('[telegram]', err?.message || err));
  await bot.launch({ dropPendingUpdates: false });
  console.log(`[telegram] bot started${services.botUsername ? ` as @${services.botUsername}` : ''}`);

  const stop = async () => {
    try { bot.stop(); } catch {}
    await bmcStore.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return bot;
}

module.exports = { startTelegramBot };
