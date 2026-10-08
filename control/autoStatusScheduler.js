// control/autoStatusScheduler.js
// Persistent automatic personal WhatsApp status scheduler for BMEDIA-MD.
// Audience is loaded fresh from assets/contacts.vcf for every post.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CONTROL_DIR = path.join(ROOT, "control");
const STORE_FILE = path.join(CONTROL_DIR, "autostatus-schedules.json");
const MEDIA_DIR = path.join(CONTROL_DIR, "autostatus-media");
const CONTACTS_FILE = path.join(ROOT, "assets", "contacts.vcf");
const DEFAULT_TZ = String(process.env.TIMEZONE || "Africa/Douala").trim();
const TICK_MS = 15_000;

const DAY_KEYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

let schedulerSock = null;
let schedulerStarted = false;
let tickRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function ensureStorage() {
  if (!fs.existsSync(CONTROL_DIR)) fs.mkdirSync(CONTROL_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({ version: 1, schedules: [], updatedAt: nowIso() }, null, 2),
      "utf8"
    );
  }
}

function normalizeStore(value) {
  const store = value && typeof value === "object" ? value : {};
  if (!Array.isArray(store.schedules)) store.schedules = [];
  store.version = 1;
  return store;
}

function readStore() {
  ensureStorage();
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, "utf8") || "{}"));
  } catch {
    return { version: 1, schedules: [], updatedAt: nowIso() };
  }
}

function writeStore(store) {
  ensureStorage();
  const normalized = normalizeStore(store);
  normalized.updatedAt = nowIso();
  const tmp = `${STORE_FILE}.next-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function clean(value = "") {
  return String(value ?? "").trim();
}

function normalizeTime(value = "") {
  const m = clean(value).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return "";
  return `${String(m[1]).padStart(2, "0")}:${m[2]}`;
}

function normalizeDate(value = "") {
  const m = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const test = new Date(Date.UTC(y, mo - 1, d));
  if (
    test.getUTCFullYear() !== y ||
    test.getUTCMonth() !== mo - 1 ||
    test.getUTCDate() !== d
  ) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizeRepeat(raw = "") {
  const value = clean(raw).toLowerCase();
  if (!value) throw new Error("Repeat is required: daily, once, or weekdays such as mon,wed,fri.");

  if (value === "daily") return { repeat: "daily", days: [] };
  if (value === "once") return { repeat: "once", days: [] };

  let dayText = value;
  if (value === "weekdays") dayText = "mon,tue,wed,thu,fri";
  if (value === "weekends") dayText = "sat,sun";

  const days = [...new Set(dayText.split(/[\s,]+/).map((x) => x.slice(0, 3)).filter(Boolean))];
  if (!days.length || days.some((d) => !DAY_KEYS.has(d))) {
    throw new Error("Invalid repeat. Use daily, once, weekdays, weekends, or days like mon,wed,fri.");
  }
  return { repeat: "weekly", days };
}

function parseScheduleRule(whenRaw, repeatRaw) {
  const rep = normalizeRepeat(repeatRaw);
  const when = clean(whenRaw);

  if (rep.repeat === "once") {
    const m = when.match(/^(\d{4}-\d{2}-\d{2})\s+([0-2]?\d:[0-5]\d)$/);
    if (!m) throw new Error("One-time schedules use: YYYY-MM-DD HH:MM");
    const date = normalizeDate(m[1]);
    const time = normalizeTime(m[2]);
    if (!date || !time) throw new Error("Invalid one-time date/time. Use YYYY-MM-DD HH:MM");
    return { repeat: "once", days: [], date, time };
  }

  const time = normalizeTime(when);
  if (!time) throw new Error("Recurring schedules use HH:MM, for example 07:30");
  return { ...rep, date: "", time };
}

function getTimeParts(timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    day: get("weekday").slice(0, 3).toLowerCase(),
  };
}

function scheduleRunKey(schedule, current) {
  return `${schedule.id}:${current.date}:${schedule.time}`;
}

function isDue(schedule, current) {
  if (!schedule?.enabled || schedule?.completed) return false;
  if (schedule.time !== current.time) return false;

  if (schedule.repeat === "once") return schedule.date === current.date;
  if (schedule.repeat === "daily") return true;
  if (schedule.repeat === "weekly") return Array.isArray(schedule.days) && schedule.days.includes(current.day);
  return false;
}

function unfoldVCard(text = "") {
  return String(text || "").replace(/\r?\n[ \t]/g, "");
}

function phoneToJid(value = "") {
  let raw = clean(value)
    .replace(/^tel:/i, "")
    .replace(/^\+/, "")
    .replace(/[^\d]/g, "");
  if (raw.startsWith("00")) raw = raw.slice(2);
  if (raw.length < 7) return "";
  return `${raw}@s.whatsapp.net`;
}


function configuredOwnerNumber() {
  const values = [
    process.env.OWNER_NUMBER,
    process.env.BOT_OWNER,
    process.env.PHONE_NUMBER,
  ];

  for (const value of values) {
    const digits = clean(value).replace(/[^\d]/g, "");
    if (digits.length >= 7) return digits;
  }

  return "";
}

/**
 * Ensure the bot owner's number is present in assets/contacts.vcf.
 * The file is changed only when the configured owner is missing.
 */
export function ensureOwnerInStatusContacts() {
  const ownerNumber = configuredOwnerNumber();
  if (!ownerNumber) {
    return { added: false, ownerNumber: "", reason: "OWNER_NUMBER is missing or invalid." };
  }

  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });

  let content = "";
  if (fs.existsSync(CONTACTS_FILE)) {
    content = fs.readFileSync(CONTACTS_FILE, "utf8");
  }

  const unfolded = unfoldVCard(content);
  const existing = new Set();
  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^(?:item\d+\.)?TEL(?:;[^:]*)?:(.+)$/i);
    if (!match) continue;
    const jid = phoneToJid(match[1]);
    if (jid) existing.add(jid);
  }

  const ownerJid = `${ownerNumber}@s.whatsapp.net`;
  if (existing.has(ownerJid)) {
    return { added: false, ownerNumber: `+${ownerNumber}`, jid: ownerJid };
  }

  const card = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:BMEDIA Owner",
    `TEL;TYPE=CELL:+${ownerNumber}`,
    "END:VCARD",
    "",
  ].join("\r\n");

  const prefix = content && !/[\r\n]$/.test(content) ? "\r\n" : "";
  fs.appendFileSync(CONTACTS_FILE, `${prefix}${card}`, "utf8");

  return { added: true, ownerNumber: `+${ownerNumber}`, jid: ownerJid };
}

export function loadAutoStatusRecipients() {
  if (!fs.existsSync(CONTACTS_FILE)) {
    throw new Error("contacts.vcf not found. Put it at assets/contacts.vcf");
  }

  const content = unfoldVCard(fs.readFileSync(CONTACTS_FILE, "utf8"));
  const recipients = new Set();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(?:item\d+\.)?TEL(?:;[^:]*)?:(.+)$/i);
    if (!match) continue;
    const jid = phoneToJid(match[1]);
    if (jid) recipients.add(jid);
  }

  return [...recipients];
}

export function getAutoStatusContactsInfo() {
  try {
    const stat = fs.statSync(CONTACTS_FILE);
    const recipients = loadAutoStatusRecipients();
    return {
      exists: true,
      path: CONTACTS_FILE,
      count: recipients.length,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return {
      exists: false,
      path: CONTACTS_FILE,
      count: 0,
      error: error?.message || String(error),
    };
  }
}

function extensionFor(type, mimetype = "") {
  const mt = clean(mimetype).toLowerCase();
  if (type === "image") {
    if (mt.includes("png")) return ".png";
    if (mt.includes("webp")) return ".webp";
    return ".jpg";
  }
  if (type === "video") return ".mp4";
  if (type === "audio") {
    if (mt.includes("mpeg") || mt.includes("mp3")) return ".mp3";
    if (mt.includes("mp4") || mt.includes("m4a")) return ".m4a";
    return ".ogg";
  }
  return ".bin";
}

function removeMedia(schedule) {
  try {
    if (!schedule?.mediaFile) return;
    const full = path.join(MEDIA_DIR, path.basename(schedule.mediaFile));
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
  } catch {}
}

function findSchedule(store, query = "") {
  const q = clean(query).toLowerCase();
  if (!q) return null;
  return store.schedules.find(
    (s) => clean(s.id).toLowerCase() === q || clean(s.name).toLowerCase() === q
  ) || null;
}

export function listAutoStatusSchedules() {
  return readStore().schedules.map((s) => ({ ...s }));
}

export function addAutoStatusSchedule({
  name,
  when,
  repeat,
  text = "",
  media = null,
  caption = "",
  timezone = DEFAULT_TZ,
} = {}) {
  const scheduleName = clean(name);
  if (!scheduleName) throw new Error("Schedule name is required.");
  if (scheduleName.length > 80) throw new Error("Schedule name is too long. Maximum is 80 characters.");

  const store = readStore();
  const duplicate = store.schedules.some((s) => clean(s.name).toLowerCase() === scheduleName.toLowerCase());
  if (duplicate) throw new Error(`A schedule named "${scheduleName}" already exists.`);

  const rule = parseScheduleRule(when, repeat);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const schedule = {
    id,
    name: scheduleName,
    enabled: true,
    completed: false,
    repeat: rule.repeat,
    days: rule.days,
    date: rule.date,
    time: rule.time,
    timezone: clean(timezone) || DEFAULT_TZ,
    type: media?.type || "text",
    text: clean(text),
    caption: clean(caption),
    mediaFile: "",
    mimetype: clean(media?.mimetype),
    ptt: Boolean(media?.ptt),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastRunKey: "",
    lastSentAt: "",
    lastError: "",
    lastErrorAt: "",
  };

  if (media?.buffer) {
    if (!Buffer.isBuffer(media.buffer) || !media.buffer.length) throw new Error("Scheduled media is empty.");
    const maxBytes = 64 * 1024 * 1024;
    if (media.buffer.length > maxBytes) throw new Error("Scheduled media is larger than 64 MB.");
    const filename = `${id}${extensionFor(media.type, media.mimetype)}`;
    fs.writeFileSync(path.join(MEDIA_DIR, filename), media.buffer);
    schedule.mediaFile = filename;
  } else if (!schedule.text) {
    throw new Error("Text is required when no image/video/audio is supplied.");
  }

  store.schedules.push(schedule);
  writeStore(store);
  return { ...schedule };
}

export function deleteAutoStatusSchedule(query) {
  const store = readStore();
  const target = findSchedule(store, query);
  if (!target) return null;

  removeMedia(target);
  store.schedules = store.schedules.filter((s) => s.id !== target.id);
  writeStore(store);
  return { ...target };
}

export function setAutoStatusScheduleEnabled(query, enabled) {
  const store = readStore();
  const target = findSchedule(store, query);
  if (!target) return null;

  target.enabled = Boolean(enabled);
  if (enabled && target.repeat !== "once") target.completed = false;
  target.updatedAt = nowIso();
  writeStore(store);
  return { ...target };
}

async function postSchedule(sock, schedule) {
  if (!sock) throw new Error("WhatsApp socket is not connected.");
  // Safety net: keep the current owner in the audience even after restarts or .env changes.
  ensureOwnerInStatusContacts();
  const statusJidList = loadAutoStatusRecipients();
  if (!statusJidList.length) throw new Error("contacts.vcf contains no valid TEL numbers.");

  let content;
  if (schedule.type === "text") {
    content = { text: clean(schedule.text) };
  } else {
    if (!schedule.mediaFile) throw new Error("Scheduled media file is missing from schedule metadata.");
    const mediaPath = path.join(MEDIA_DIR, path.basename(schedule.mediaFile));
    if (!fs.existsSync(mediaPath)) throw new Error(`Scheduled media file is missing: ${schedule.mediaFile}`);
    const buffer = fs.readFileSync(mediaPath);

    if (schedule.type === "image") {
      content = schedule.caption ? { image: buffer, caption: schedule.caption } : { image: buffer };
    } else if (schedule.type === "video") {
      content = schedule.caption ? { video: buffer, caption: schedule.caption } : { video: buffer };
    } else if (schedule.type === "audio") {
      content = {
        audio: buffer,
        mimetype: schedule.mimetype || "audio/ogg; codecs=opus",
        ptt: Boolean(schedule.ptt),
      };
    } else {
      throw new Error(`Unsupported scheduled status type: ${schedule.type}`);
    }
  }

  const options = {
    broadcast: true,
    statusJidList,
  };

  if (schedule.type === "text") {
    options.backgroundColor = "#0B141A";
    options.font = 1;
  }

  await sock.sendMessage("status@broadcast", content, options);
  return { recipients: statusJidList.length };
}

export async function runAutoStatusScheduleNow(sock, query) {
  const store = readStore();
  const target = findSchedule(store, query);
  if (!target) return null;

  try {
    const result = await postSchedule(sock, target);
    target.lastManualRunAt = nowIso();
    target.lastSentAt = target.lastManualRunAt;
    target.lastError = "";
    target.lastErrorAt = "";
    target.updatedAt = nowIso();
    writeStore(store);
    return { schedule: { ...target }, ...result };
  } catch (error) {
    target.lastError = error?.message || String(error);
    target.lastErrorAt = nowIso();
    target.updatedAt = nowIso();
    writeStore(store);
    throw error;
  }
}

async function schedulerTick() {
  if (!schedulerSock || tickRunning) return;
  tickRunning = true;

  try {
    const store = readStore();
    let changed = false;

    for (const schedule of store.schedules) {
      try {
        const current = getTimeParts(schedule.timezone || DEFAULT_TZ);
        if (!isDue(schedule, current)) continue;

        const runKey = scheduleRunKey(schedule, current);
        if (schedule.lastRunKey === runKey || schedule.lastAttemptKey === runKey) continue;

        schedule.lastAttemptKey = runKey;
        schedule.lastAttemptAt = nowIso();
        schedule.updatedAt = nowIso();
        changed = true;
        writeStore(store);

        const result = await postSchedule(schedulerSock, schedule);
        schedule.lastRunKey = runKey;
        schedule.lastSentAt = nowIso();
        schedule.lastRecipients = result.recipients;
        schedule.lastError = "";
        schedule.lastErrorAt = "";
        if (schedule.repeat === "once") {
          schedule.completed = true;
          schedule.enabled = false;
        }
        schedule.updatedAt = nowIso();
        changed = true;
        console.log(`[autoStatus] posted "${schedule.name}" to ${result.recipients} recipient(s)`);
      } catch (error) {
        schedule.lastError = error?.message || String(error);
        schedule.lastErrorAt = nowIso();
        schedule.updatedAt = nowIso();
        changed = true;
        console.error(`[autoStatus] "${schedule?.name || schedule?.id}" failed:`, schedule.lastError);
      }
    }

    if (changed) writeStore(store);
  } finally {
    tickRunning = false;
  }
}

export function startAutoStatusScheduler(sock) {
  schedulerSock = sock;
  ensureStorage();

  if (schedulerStarted) return true;
  schedulerStarted = true;

  setInterval(() => {
    schedulerTick().catch((error) => {
      console.error("[autoStatus] scheduler tick failed:", error?.message || error);
    });
  }, TICK_MS).unref?.();

  setTimeout(() => {
    schedulerTick().catch(() => {});
  }, 5000).unref?.();

  console.log(`[autoStatus] scheduler started | timezone=${DEFAULT_TZ} | contacts=assets/contacts.vcf`);
  return true;
}

export function getAutoStatusStorePath() {
  return STORE_FILE;
}
