const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let users = null;
let groups = null;
let transactions = null;
let initialized = false;

function idOf(v) {
  return String(v ?? '').trim();
}

function positiveInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

async function collections() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI is not configured.');

  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 6 });
    await client.connect();
  }

  if (!db) {
    const dbName = String(
      process.env.BMC_DB_NAME || process.env.SESSION_DB_NAME || 'bmedia_sessions'
    ).trim();
    db = client.db(dbName);
  }

  if (!users) {
    users = db.collection(String(process.env.BMC_USER_COLLECTION || 'telegram_users').trim());
    groups = db.collection(String(process.env.BMC_GROUP_COLLECTION || 'telegram_group_subscriptions').trim());
    transactions = db.collection(String(process.env.BMC_TRANSACTION_COLLECTION || 'telegram_bmc_transactions').trim());
  }

  if (!initialized) {
    initialized = true;
    await Promise.all([
      users.createIndex({ telegramUserId: 1 }, { unique: true }).catch(() => {}),
      users.createIndex({ referredBy: 1 }).catch(() => {}),
      users.createIndex({ updatedAt: -1 }).catch(() => {}),
      users.createIndex({ premiumImageHash: 1 }, { unique: true, sparse: true }).catch(() => {}),
      groups.createIndex({ groupChatId: 1 }, { unique: true }).catch(() => {}),
      groups.createIndex({ activatedBy: 1, activeUntil: -1 }).catch(() => {}),
      groups.createIndex({ activeUntil: 1 }).catch(() => {}),
      transactions.createIndex({ telegramUserId: 1, createdAt: -1 }).catch(() => {}),
      transactions.createIndex({ createdAt: -1 }).catch(() => {}),
    ]);
  }

  return { users, groups, transactions };
}

function profileFromCtx(ctx) {
  const from = ctx?.from || {};
  return {
    telegramUserId: idOf(from.id),
    username: idOf(from.username),
    firstName: idOf(from.first_name),
    lastName: idOf(from.last_name),
    languageCode: idOf(from.language_code),
  };
}

function initialUserFields(now = new Date()) {
  return {
    balanceBmc: 0,
    totalInvites: 0,
    totalSpentBmc: 0,
    totalReceivedBmc: 0,
    referredBy: null,
    referralClaimed: false,
    premiumVerified: false,
    createdAt: now,
  };
}

function minimalUserFields(now = new Date(), exclude = []) {
  const base = {
    username: '',
    firstName: '',
    lastName: '',
    languageCode: '',
    balanceBmc: 0,
    totalInvites: 0,
    totalSpentBmc: 0,
    totalReceivedBmc: 0,
    referredBy: null,
    referralClaimed: false,
    premiumVerified: false,
    createdAt: now,
  };
  for (const key of exclude) delete base[key];
  return base;
}

async function ensureUser(ctx) {
  const profile = profileFromCtx(ctx);
  if (!profile.telegramUserId) throw new Error('Telegram user ID unavailable.');

  const { users: col } = await collections();
  const now = new Date();
  await col.updateOne(
    { telegramUserId: profile.telegramUserId },
    {
      $set: { ...profile, updatedAt: now },
      $setOnInsert: initialUserFields(now),
    },
    { upsert: true }
  );

  return col.findOne({ telegramUserId: profile.telegramUserId });
}

async function getUser(ctx) {
  return ensureUser(ctx);
}

async function getUserById(userIdRaw) {
  const userId = idOf(userIdRaw);
  if (!userId) return null;
  const { users: col } = await collections();
  return col.findOne({ telegramUserId: userId });
}

async function logTransaction({ userId, type, amount, balanceAfter = null, actorId = '', metadata = {} }) {
  try {
    const { transactions: col } = await collections();
    await col.insertOne({
      telegramUserId: idOf(userId),
      type: String(type || 'unknown'),
      amount: Number(amount || 0),
      balanceAfter: Number.isFinite(Number(balanceAfter)) ? Number(balanceAfter) : null,
      actorId: idOf(actorId),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn('[bmc] transaction log failed:', e?.message || e);
  }
}

async function processReferral(ctx, referrerIdRaw) {
  const inviteeId = idOf(ctx?.from?.id);
  const referrerId = idOf(referrerIdRaw);
  if (!inviteeId || !referrerId) return { rewarded: false, reason: 'invalid' };
  if (inviteeId === referrerId) return { rewarded: false, reason: 'self' };

  const { users: col } = await collections();
  const invitee = await ensureUser(ctx);

  const now = new Date();
  const claim = await col.updateOne(
    {
      telegramUserId: inviteeId,
      referralClaimed: { $ne: true },
      $or: [{ referredBy: null }, { referredBy: { $exists: false } }],
    },
    {
      $set: {
        referredBy: referrerId,
        referralClaimed: true,
        referredAt: now,
        updatedAt: now,
      },
    }
  );

  if (claim.modifiedCount !== 1) return { rewarded: false, reason: 'already_claimed' };

  try {
    await col.updateOne(
      { telegramUserId: referrerId },
      {
        $inc: { balanceBmc: 1, totalInvites: 1, totalReceivedBmc: 1 },
        $set: { updatedAt: now },
        $setOnInsert: minimalUserFields(now, ['balanceBmc', 'totalInvites', 'totalReceivedBmc']),
      },
      { upsert: true }
    );
  } catch (e) {
    // Do not permanently consume a referral if the reward could not be credited.
    await col.updateOne(
      { telegramUserId: inviteeId, referredBy: referrerId, referralClaimed: true },
      { $set: { referredBy: null, referralClaimed: false, updatedAt: new Date() }, $unset: { referredAt: '' } }
    ).catch(() => {});
    throw e;
  }

  const referrer = await col.findOne({ telegramUserId: referrerId });
  await logTransaction({
    userId: referrerId,
    type: 'referral_reward',
    amount: 1,
    balanceAfter: referrer?.balanceBmc ?? null,
    actorId: inviteeId,
    metadata: { inviteeId },
  });

  return {
    rewarded: true,
    referrerId,
    referrerBalance: Number(referrer?.balanceBmc || 0),
    invitee: {
      telegramUserId: inviteeId,
      username: idOf(invitee?.username || ctx?.from?.username),
      firstName: idOf(invitee?.firstName || ctx?.from?.first_name),
      lastName: idOf(invitee?.lastName || ctx?.from?.last_name),
    },
  };
}

async function creditUser(userIdRaw, amountRaw, { type = 'admin_mint', actorId = '', metadata = {} } = {}) {
  const userId = idOf(userIdRaw);
  const amount = positiveInt(amountRaw);
  if (!userId) throw new Error('Target Telegram user ID is required.');
  if (!amount) throw new Error('BMC amount must be a positive whole number.');

  const { users: col } = await collections();
  const now = new Date();
  const doc = await col.findOneAndUpdate(
    { telegramUserId: userId },
    {
      $inc: { balanceBmc: amount, totalReceivedBmc: amount },
      $set: { updatedAt: now },
      $setOnInsert: minimalUserFields(now, ['balanceBmc', 'totalReceivedBmc']),
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: false }
  );

  await logTransaction({
    userId,
    type,
    amount,
    balanceAfter: doc?.balanceBmc ?? null,
    actorId,
    metadata,
  });

  return doc || col.findOne({ telegramUserId: userId });
}

async function debitUser(userIdRaw, amountRaw, { type = 'spend', actorId = '', metadata = {} } = {}) {
  const userId = idOf(userIdRaw);
  const amount = positiveInt(amountRaw);
  if (!userId) throw new Error('Telegram user ID is required.');
  if (!amount) throw new Error('BMC amount must be a positive whole number.');

  const { users: col } = await collections();
  const doc = await col.findOneAndUpdate(
    { telegramUserId: userId, balanceBmc: { $gte: amount } },
    {
      $inc: { balanceBmc: -amount, totalSpentBmc: amount },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: 'after', includeResultMetadata: false }
  );

  if (!doc) {
    const current = await col.findOne({ telegramUserId: userId });
    return { ok: false, balanceBmc: Number(current?.balanceBmc || 0) };
  }

  await logTransaction({
    userId,
    type,
    amount: -amount,
    balanceAfter: doc.balanceBmc,
    actorId,
    metadata,
  });

  return { ok: true, user: doc, balanceBmc: Number(doc.balanceBmc || 0) };
}


async function refundDebit(userIdRaw, amountRaw, { type = 'refund', actorId = '', metadata = {} } = {}) {
  const userId = idOf(userIdRaw);
  const amount = positiveInt(amountRaw);
  if (!userId || !amount) return null;
  const { users: col } = await collections();
  const doc = await col.findOneAndUpdate(
    { telegramUserId: userId },
    {
      $inc: { balanceBmc: amount, totalSpentBmc: -amount },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: 'after', includeResultMetadata: false }
  );
  await logTransaction({
    userId,
    type,
    amount,
    balanceAfter: doc?.balanceBmc ?? null,
    actorId,
    metadata,
  });
  return doc;
}

async function transferBmc(fromIdRaw, toIdRaw, amountRaw) {
  const fromId = idOf(fromIdRaw);
  const toId = idOf(toIdRaw);
  const amount = positiveInt(amountRaw);
  if (!fromId || !toId) throw new Error('Both Telegram user IDs are required.');
  if (fromId === toId) throw new Error('Sender and recipient cannot be the same account.');
  if (!amount) throw new Error('BMC amount must be a positive whole number.');

  const debit = await debitUser(fromId, amount, {
    type: 'admin_transfer_out',
    actorId: fromId,
    metadata: { toUserId: toId },
  });
  if (!debit.ok) return { ok: false, reason: 'insufficient', balanceBmc: debit.balanceBmc };

  try {
    const recipient = await creditUser(toId, amount, {
      type: 'admin_transfer_in',
      actorId: fromId,
      metadata: { fromUserId: fromId },
    });
    return {
      ok: true,
      senderBalance: debit.balanceBmc,
      recipientBalance: Number(recipient?.balanceBmc || 0),
    };
  } catch (e) {
    // Compensate if the recipient credit fails after the debit succeeds.
    await refundDebit(fromId, amount, {
      type: 'transfer_refund',
      actorId: fromId,
      metadata: { failedRecipientId: toId },
    }).catch(() => {});
    throw e;
  }
}


async function getPremiumAccess(userIdRaw) {
  const userId = idOf(userIdRaw);
  if (!userId) return { verified: false, user: null };
  const user = await getUserById(userId);
  return {
    verified: Boolean(user?.premiumVerified),
    verifiedAt: user?.premiumVerifiedAt || null,
    user,
  };
}

async function markPremiumVerified(userIdRaw, {
  imageHash,
  provider = 'ocr.space',
  matchedTerms = [],
} = {}) {
  const userId = idOf(userIdRaw);
  const hash = idOf(imageHash);
  if (!userId) throw new Error('Telegram user ID is required.');
  if (!hash) throw new Error('Verification image hash is required.');

  const { users: col } = await collections();
  const used = await col.findOne({
    premiumImageHash: hash,
    telegramUserId: { $ne: userId },
  });
  if (used) return { ok: false, reason: 'image_used' };

  const now = new Date();
  try {
    const doc = await col.findOneAndUpdate(
      { telegramUserId: userId },
      {
        $set: {
          premiumVerified: true,
          premiumVerifiedAt: now,
          premiumVerificationProvider: String(provider || 'ocr.space'),
          premiumImageHash: hash,
          premiumMatchedTerms: Array.isArray(matchedTerms) ? matchedTerms.slice(0, 12) : [],
          updatedAt: now,
        },
        $setOnInsert: minimalUserFields(now, ['premiumVerified']),
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    return { ok: true, user: doc || await col.findOne({ telegramUserId: userId }) };
  } catch (e) {
    if (e?.code === 11000) return { ok: false, reason: 'image_used' };
    throw e;
  }
}

async function getAntiLinkGroup(chatIdRaw) {
  const groupChatId = idOf(chatIdRaw);
  if (!groupChatId) return null;
  const { groups: col } = await collections();
  return col.findOne({ groupChatId });
}

function isSubscriptionActive(group, now = new Date()) {
  return Boolean(group?.activeUntil && new Date(group.activeUntil).getTime() > now.getTime());
}

async function activateAntiLink({ chatId, title = '', actorId, renew = false }) {
  const groupChatId = idOf(chatId);
  const purchaserId = idOf(actorId);
  if (!groupChatId || !purchaserId) throw new Error('Group and purchaser IDs are required.');

  const { groups: col } = await collections();
  const now = new Date();
  const existing = await col.findOne({ groupChatId });
  const active = isSubscriptionActive(existing, now);

  if (active && !renew) {
    if (existing.enabled === false) {
      await col.updateOne(
        { groupChatId },
        { $set: { enabled: true, title: String(title || existing.title || ''), updatedAt: now } }
      );
    }
    const current = await col.findOne({ groupChatId });
    return { ok: true, charged: false, alreadyActive: true, group: current };
  }

  const debit = await debitUser(purchaserId, 1, {
    type: 'antilink_subscription',
    actorId: purchaserId,
    metadata: { groupChatId, groupTitle: String(title || '') },
  });
  if (!debit.ok) return { ok: false, reason: 'insufficient', balanceBmc: debit.balanceBmc };

  const baseMs = active && renew
    ? new Date(existing.activeUntil).getTime()
    : now.getTime();
  const activeUntil = new Date(baseMs + 30 * 24 * 60 * 60 * 1000);

  try {
    await col.updateOne(
      { groupChatId },
      {
        $set: {
          groupChatId,
          title: String(title || existing?.title || ''),
          enabled: true,
          activeUntil,
          activatedBy: purchaserId,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
        $inc: { totalMonthsPaid: 1 },
      },
      { upsert: true }
    );
  } catch (e) {
    await refundDebit(purchaserId, 1, {
      type: 'antilink_refund',
      actorId: purchaserId,
      metadata: { groupChatId },
    }).catch(() => {});
    throw e;
  }

  const group = await col.findOne({ groupChatId });
  return {
    ok: true,
    charged: true,
    alreadyActive: false,
    balanceBmc: debit.balanceBmc,
    group,
  };
}

async function setAntiLinkEnabled(chatIdRaw, enabled) {
  const groupChatId = idOf(chatIdRaw);
  const { groups: col } = await collections();
  const now = new Date();
  const existing = await col.findOne({ groupChatId });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!isSubscriptionActive(existing, now)) return { ok: false, reason: 'expired', group: existing };

  await col.updateOne(
    { groupChatId },
    { $set: { enabled: Boolean(enabled), updatedAt: now } }
  );
  return { ok: true, group: await col.findOne({ groupChatId }) };
}

async function close() {
  try { await client?.close(); } catch {}
  client = null;
  db = null;
  users = null;
  groups = null;
  transactions = null;
  initialized = false;
}

module.exports = {
  ensureUser,
  getUser,
  getUserById,
  processReferral,
  creditUser,
  debitUser,
  transferBmc,
  getPremiumAccess,
  markPremiumVerified,
  getAntiLinkGroup,
  isSubscriptionActive,
  activateAntiLink,
  setAntiLinkEnabled,
  close,
};
