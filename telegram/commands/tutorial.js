const crypto = require('crypto');
const bmcStore = require('../lib/bmcStore');
const { escapeHtml } = require('../lib/helpers');

const waitingForScreenshot = new Map();
const attemptHistory = new Map();
const VERIFY_TTL_MS = 3 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_HOUR = 5;
const MAX_OCR_BYTES = 950 * 1024;
const MAX_CONCURRENT_OCR = 3;
let activeOcr = 0;

function keyOf(ctx) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  return chatId == null || userId == null ? '' : `${chatId}:${userId}`;
}

function armScreenshot(ctx) {
  const key = keyOf(ctx);
  if (key) waitingForScreenshot.set(key, Date.now() + VERIFY_TTL_MS);
}

function consumeScreenshot(ctx) {
  const key = keyOf(ctx);
  if (!key) return false;
  const expiresAt = waitingForScreenshot.get(key);
  if (!expiresAt) return false;
  waitingForScreenshot.delete(key);
  return expiresAt > Date.now();
}

function allowAttempt(userIdRaw) {
  const userId = String(userIdRaw || '');
  const now = Date.now();
  const recent = (attemptHistory.get(userId) || []).filter(ts => now - ts < ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS_PER_HOUR) {
    attemptHistory.set(userId, recent);
    return false;
  }
  recent.push(now);
  attemptHistory.set(userId, recent);
  return true;
}

function validHttpUrl(value) {
  const v = String(value || '').trim();
  return /^https?:\/\//i.test(v) ? v : '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^\p{L}\p{N}@\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function matchVerificationText(text, services) {
  const normalized = normalizeText(text);
  const packed = compact(text);
  const channel = compact(services.youtubeChannelName || 'BMEDIA-MD');
  const handle = compact(services.youtubeChannelHandle || '@bmedia-md');
  const phrase = compact(services.youtubeVerifyPhrase || 'DZL4');

  // YouTube localizes the subscription label. English and French cover the
  // primary BMEDIA audience, with a few common variants accepted as well.
  const subscribedWords = [
    'subscribed', 'abonné', 'abonne', 'suscrito', 'inscrito', 'abonniert',
  ];
  const subscribed = subscribedWords.some(word => normalized.includes(normalizeText(word)));

  const checks = {
    channel: Boolean(channel && packed.includes(channel)),
    handle: Boolean(handle && packed.includes(handle)),
    phrase: Boolean(phrase && packed.includes(phrase)),
    subscribed,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    matchedTerms: Object.entries(checks).filter(([, ok]) => ok).map(([name]) => name),
  };
}

async function fetchTelegramImage(ctx) {
  const msg = ctx.message || {};
  let fileId = '';
  let expectedSize = 0;
  let fallbackName = 'subscription.jpg';

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const ordered = [...msg.photo].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    const selected = ordered.find(p => !p.file_size || p.file_size <= MAX_OCR_BYTES)
      || [...ordered].reverse()[0];
    fileId = selected?.file_id || '';
    expectedSize = Number(selected?.file_size || 0);
  } else if (msg.document && String(msg.document.mime_type || '').startsWith('image/')) {
    fileId = msg.document.file_id || '';
    expectedSize = Number(msg.document.file_size || 0);
    fallbackName = String(msg.document.file_name || 'subscription.jpg');
  }

  if (!fileId) throw new Error('Send the screenshot as a Telegram photo.');
  if (expectedSize > MAX_OCR_BYTES) throw new Error('Screenshot is too large. Send it as a normal Telegram photo, not as a file.');

  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Telegram image download failed (HTTP ${res.status}).`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('The screenshot was empty.');
  if (buf.length > MAX_OCR_BYTES) throw new Error('Screenshot is too large for verification. Send it as a normal Telegram photo.');

  const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { buf, mime, filename: fallbackName };
}

async function ocrSpace(buffer, mime, filename, apiKey) {
  if (!apiKey) throw new Error('OCR verification is not configured.');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'image/jpeg' }), filename || 'subscription.jpg');
  form.append('language', 'auto');
  form.append('isOverlayRequired', 'false');
  form.append('detectOrientation', 'true');
  form.append('scale', 'true');
  form.append('OCREngine', '2');

  const res = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { apikey: apiKey },
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OCR service returned HTTP ${res.status}.`);
  if (!data || data.IsErroredOnProcessing) {
    const err = Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join(' ') : String(data?.ErrorMessage || data?.ErrorDetails || 'OCR processing failed.');
    throw new Error(err.slice(0, 220));
  }

  const text = (data.ParsedResults || []).map(r => String(r?.ParsedText || '')).join('\n').trim();
  if (!text) throw new Error('No readable text was detected in the screenshot.');
  return text;
}

function statusLines(checks) {
  const label = (ok) => ok ? '✅' : '❌';
  return [
    `${label(checks.channel)} Channel name`,
    `${label(checks.handle)} @handle`,
    `${label(checks.subscribed)} Subscribed`,
    `${label(checks.phrase)} Verification code`,
  ];
}

function privateOnlyKeyboard(services) {
  const username = String(services.botUsername || '').replace(/^@/, '');
  if (!username) return undefined;
  return {
    reply_markup: {
      inline_keyboard: [[{
        text: '🔐 Open BMEDIA Premium',
        url: `https://t.me/${username}?start=premium`,
        style: 'primary',
      }]],
    },
  };
}

function baseKeyboard(services, verified) {
  const rows = [];
  const freeUrl = validHttpUrl(services.tutorialUrl);
  const subscribeUrl = validHttpUrl(services.youtubeSubscribeUrl || services.brandUrl);

  if (freeUrl) rows.push([{ text: '🎬 Deployment Tutorial · FREE', url: freeUrl, style: 'success' }]);

  if (verified) {
    rows.push([{ text: '🔓 Premium Tutorials', callback_data: 'bmedia_premium_library', style: 'success' }]);
  } else {
    if (subscribeUrl) rows.push([{ text: '▶️ Subscribe to BMEDIA-MD', url: subscribeUrl, style: 'primary' }]);
    rows.push([{ text: '✅ Verify Subscription', callback_data: 'bmedia_premium_verify', style: 'primary' }]);
  }

  return { reply_markup: { inline_keyboard: rows } };
}

async function renderHome(ctx, services) {
  if (ctx.chat?.type !== 'private') {
    return ctx.reply('🔐 <b>BMEDIA Premium verification is private.</b>\nOpen the bot directly to access tutorials and verify your subscription.', {
      parse_mode: 'HTML',
      ...(privateOnlyKeyboard(services) || {}),
    });
  }

  const access = await bmcStore.getPremiumAccess(ctx.from?.id);
  const status = access.verified ? '✅ Verified subscriber' : '🔒 Premium locked';
  const text = [
    '╭─〔 <b>BMEDIA PREMIUM</b> 〕',
    '├◦ Deployment tutorial: <b>FREE</b>',
    `├◦ Premium tutorials: <b>${access.verified ? 'UNLOCKED' : 'LOCKED'}</b>`,
    `╰◦ Status: ${status}`,
    '',
    access.verified
      ? 'Your premium access is linked to this Telegram account.'
      : 'Subscribe to <b>BMEDIA-MD</b>, then verify with a screenshot to unlock premium tutorials.',
  ].join('\n');

  return ctx.reply(text, {
    parse_mode: 'HTML',
    ...baseKeyboard(services, access.verified),
  });
}

async function showPremiumLibrary(ctx, services) {
  const access = await bmcStore.getPremiumAccess(ctx.from?.id);
  if (!access.verified) {
    await ctx.answerCbQuery?.('Premium is still locked.', { show_alert: true }).catch(() => {});
    return renderHome(ctx, services);
  }

  const tutorials = Array.isArray(services.premiumTutorials) ? services.premiumTutorials : [];
  if (!tutorials.length) {
    return ctx.reply('✅ <b>Premium access is unlocked.</b>\n\nNo premium tutorial links have been published yet.', { parse_mode: 'HTML' });
  }

  const rows = tutorials.slice(0, 20).map((item, i) => [{
    text: `🎓 ${String(item.title || `Premium Tutorial ${i + 1}`).slice(0, 50)}`,
    url: item.url,
    style: 'primary',
  }]);

  return ctx.reply('╭─〔 <b>PREMIUM TUTORIALS</b> 〕\n╰◦ Choose a tutorial below.', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
}

async function startVerification(ctx, services) {
  if (ctx.chat?.type !== 'private') {
    return ctx.reply('🔐 Verify your subscription in the bot\'s private chat.', {
      parse_mode: 'HTML',
      ...(privateOnlyKeyboard(services) || {}),
    });
  }

  const access = await bmcStore.getPremiumAccess(ctx.from?.id);
  if (access.verified) return showPremiumLibrary(ctx, services);
  if (!services.ocrSpaceApiKey) return ctx.reply('⚠️ Premium verification is temporarily unavailable.');

  armScreenshot(ctx);
  return ctx.reply([
    '╭─〔 <b>VERIFY SUBSCRIPTION</b> 〕',
    '├◦ Open the BMEDIA-MD YouTube channel',
    '├◦ Make sure <b>Subscribed</b> is visible',
    `├◦ Make sure <code>${escapeHtml(services.youtubeVerifyPhrase || 'DZL4')}</code> is visible`,
    '├◦ Send the screenshot here as a normal photo',
    '╰◦ Verification expires in 3 minutes',
    '',
    'The screenshot must show the channel name and @handle too.',
  ].join('\n'), { parse_mode: 'HTML' });
}

async function handleImage(ctx, services) {
  if (!consumeScreenshot(ctx)) return false;

  if (!allowAttempt(ctx.from?.id)) {
    await ctx.reply('⏳ Too many verification attempts. Try again in about an hour.');
    return true;
  }

  if (activeOcr >= MAX_CONCURRENT_OCR) {
    await ctx.reply('⏳ Verification is busy right now. Tap Verify Subscription again in a few seconds.');
    return true;
  }

  activeOcr += 1;
  const progress = await ctx.reply('🔎 Checking your subscription screenshot…');
  try {
    await bmcStore.ensureUser(ctx);
    const { buf, mime, filename } = await fetchTelegramImage(ctx);
    const imageHash = crypto.createHash('sha256').update(buf).digest('hex');

    const already = await bmcStore.getPremiumAccess(ctx.from?.id);
    if (already.verified) {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, '✅ Your BMEDIA Premium access is already unlocked.').catch(() => {});
      return true;
    }

    const text = await ocrSpace(buf, mime, filename, services.ocrSpaceApiKey);
    const result = matchVerificationText(text, services);

    if (!result.ok) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progress.message_id,
        undefined,
        ['❌ <b>SUBSCRIPTION NOT VERIFIED</b>', '', ...statusLines(result.checks), '', 'Make sure all four items are visible in one screenshot, then tap <b>Verify Subscription</b> and try again.'].join('\n'),
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return true;
    }

    const saved = await bmcStore.markPremiumVerified(ctx.from?.id, {
      imageHash,
      provider: 'ocr.space',
      matchedTerms: result.matchedTerms,
    });

    if (!saved.ok && saved.reason === 'image_used') {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined,
        '❌ <b>This verification screenshot has already been used by another account.</b>\n\nSend your own screenshot.',
        { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined,
      '✅ <b>SUBSCRIPTION VERIFIED</b>\n\nBMEDIA Premium has been unlocked for your Telegram account.',
      { parse_mode: 'HTML' }).catch(() => {});
    await showPremiumLibrary(ctx, services);
    return true;
  } catch (e) {
    console.warn('[premium] verification:', e?.message || e);
    await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined,
      `⚠️ Verification could not be completed.\n\n<code>${escapeHtml(e?.message || 'Try again shortly.')}</code>`,
      { parse_mode: 'HTML' }).catch(() => {});
    return true;
  } finally {
    activeOcr = Math.max(0, activeOcr - 1);
  }
}

module.exports = {
  category: 'PREMIUM',
  name: 'tutorial',
  aliases: ['tutorials', 'premium', 'guide'],
  description: 'Free deployment tutorial and BMEDIA Premium tutorials',
  run: renderHome,
  async action(ctx, services, action) {
    if (action === 'verify') return startVerification(ctx, services);
    if (action === 'library') return showPremiumLibrary(ctx, services);
    return renderHome(ctx, services);
  },
  onPhoto: handleImage,
  onDocument: handleImage,
};
