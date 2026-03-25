import fs from "fs/promises";

import path from "path";

import { MongoClient } from "mongodb";

let client = null;

let clientUri = "";

async function getClient(mongoUri) {

  if (client && clientUri === mongoUri) return client;

  const mongo = new MongoClient(mongoUri, {

    maxPoolSize: 5,

  });

  await mongo.connect();

  client = mongo;

  clientUri = mongoUri;

  return client;

}

async function getCollection({ mongoUri, dbName, collectionName }) {

  const c = await getClient(mongoUri);

  return c.db(dbName).collection(collectionName);

}

async function pathExists(p) {

  try {

    await fs.access(p);

    return true;

  } catch {

    return false;

  }

}

async function rmSafe(p) {

  try {

    await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  } catch {}

}

async function listFilesRecursive(dir, base = dir) {

  const out = [];

  if (!(await pathExists(dir))) return out;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {

      out.push(...(await listFilesRecursive(full, base)));

    } else if (entry.isFile()) {

      out.push({

        rel: path.relative(base, full).replace(/\\/g, "/"),

        full,

      });

    }

  }

  return out;

}

export async function authDirHasFiles(authDir) {

  const files = await listFilesRecursive(authDir);

  return files.length > 0;

}

async function writeAuthBundleToDir(authDir, filesMap) {

  await rmSafe(authDir);

  await fs.mkdir(authDir, { recursive: true });

  for (const [rel, content] of Object.entries(filesMap || {})) {

    const target = path.join(authDir, rel);

    await fs.mkdir(path.dirname(target), { recursive: true });

    await fs.writeFile(target, String(content ?? ""), "utf8");

  }

}

export function hasMongoSessionConfig({ mongoUri, dbName, collectionName }) {

  return !!String(mongoUri || "").trim() &&

         !!String(dbName || "").trim() &&

         !!String(collectionName || "").trim();

}

export async function restoreAuthFromSessionId({

  sessionId,

  mongoUri,

  dbName,

  collectionName,

  authDir,

}) {

  if (!sessionId) throw new Error("sessionId is required");

  if (!hasMongoSessionConfig({ mongoUri, dbName, collectionName })) {

    throw new Error("MONGODB_URI / SESSION_DB_NAME / SESSION_COLLECTION missing");

  }

  const collection = await getCollection({ mongoUri, dbName, collectionName });

  const doc = await collection.findOne({ sessionId: String(sessionId) });

  if (!doc) throw new Error("Session not found in MongoDB");

  if (!doc.files || typeof doc.files !== "object" || !Object.keys(doc.files).length) {

    throw new Error("Session document does not contain auth files");

  }

  await writeAuthBundleToDir(authDir, doc.files);

  return true;

}