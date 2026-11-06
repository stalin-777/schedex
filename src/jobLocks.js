'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { retryFileOperation } = require('./fileRetry');

const LOCK_STALE_MS = 5 * 60 * 1000;

let extContext;

function initialize(context) {
  extContext = context;
}

function getLockRoot() {
  const storagePath = extContext?.globalStorageUri?.fsPath;
  if (storagePath) return path.join(storagePath, 'locks');
  const userKey = crypto.createHash('sha256').update(`${os.homedir()}|local-schedex.schedex|${process.pid}`).digest('hex');
  return path.join(os.tmpdir(), 'schedex-locks', userKey);
}

function getLockPath(name) {
  const lockName = crypto.createHash('sha256').update(name).digest('hex') + '.lock';
  return path.join(getLockRoot(), lockName);
}

function createOwner() {
  return { pid: process.pid, hostname: os.hostname(), token: crypto.randomUUID(), createdAt: Date.now() };
}

async function readOwner(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function tryCreateLock(filePath, owner) {
  let handle;
  try {
    handle = await retryFileOperation(() => fs.open(filePath, 'wx', 0o600));
    await handle.writeFile(JSON.stringify(owner));
    await handle.close();
    return true;
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
      await retryFileOperation(() => fs.unlink(filePath)).catch(() => {});
    }
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function createLockHandle(lockPath, owner) {
  let releasing;
  const release = () => releasing ??= retryFileOperation(async () => {
    try {
      const existing = await readOwner(lockPath);
      if (existing.token === owner.token && existing.completed !== true) await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  release.markCompleted = () => retryFileOperation(async () => {
    const existing = await readOwner(lockPath);
    if (existing.token !== owner.token) throw new Error('Lost the Schedex job lock before recording completion');
    if (existing.completed === true) return;
    // Retain completion across restarts so no other window sends this job again.
    await fs.writeFile(lockPath, JSON.stringify({ ...owner, completed: true }), { mode: 0o600 });
  });
  return release;
}

async function acquireFileLock(name, waitMs = 0) {
  const lockRoot = getLockRoot();
  await fs.mkdir(lockRoot, { recursive: true });
  const lockPath = getLockPath(name);
  const owner = createOwner();
  const deadline = Date.now() + waitMs;

  while (true) {
    if (await tryCreateLock(lockPath, owner)) return createLockHandle(lockPath, owner);
    if (await removeStaleFileLock(lockPath)) continue;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function removeStaleFileLock(lockPath) {
  let stat;
  let owner;
  try {
    stat = await fs.stat(lockPath);
    owner = await readOwner(lockPath).catch(() => null);
  } catch (err) {
    return err.code === 'ENOENT';
  }

  const age = Date.now() - stat.mtimeMs;
  if (owner?.completed === true || isLockOwnerAlive(owner, age)) return false;

  const generation = owner?.token || `${stat.dev}-${stat.ino}-${Math.trunc(stat.mtimeMs)}`;
  if (!await acquireStaleCleanupTurn(lockPath, generation)) return false;
  try {
    return await retryFileOperation(async () => {
      const currentStat = await fs.stat(lockPath);
      if (currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) return false;
      const currentOwner = await readOwner(lockPath).catch(() => null);
      if (owner?.token && currentOwner?.token !== owner.token) return false;
      await fs.unlink(lockPath);
      return true;
    });
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

async function acquireStaleCleanupTurn(lockPath, lockGeneration) {
  // Immutable generations elect one cleaner. A new generation replaces only a dead cleaner.
  const key = crypto.createHash('sha256').update(lockGeneration).digest('hex').slice(0, 32);
  const reaperDir = `${lockPath}.reapers-${key}`;
  await fs.mkdir(reaperDir, { recursive: true });

  while (true) {
    let latest = -1;
    for (const name of await fs.readdir(reaperDir)) {
      const match = /^(\d+)\.json$/.exec(name);
      if (match) latest = Math.max(latest, Number(match[1]));
    }

    if (latest >= 0) {
      const latestPath = path.join(reaperDir, `${latest}.json`);
      let latestStat;
      let latestOwner;
      try {
        latestStat = await fs.stat(latestPath);
        latestOwner = await readOwner(latestPath).catch(() => null);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      const age = Date.now() - latestStat.mtimeMs;
      if (isLockOwnerAlive(latestOwner, age)) return false;
    }

    const generationPath = path.join(reaperDir, `${latest + 1}.json`);
    if (await tryCreateLock(generationPath, createOwner())) return true;
  }
}

function isLockOwnerAlive(owner, age) {
  if (owner?.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (err) {
      if (err.code !== 'ESRCH') return true;
      return false;
    }
  }
  return age < LOCK_STALE_MS;
}

async function isJobCompleted(jobId) {
  try {
    const owner = await readOwner(getLockPath(`job:${jobId}`));
    return owner.completed === true;
  } catch (_) {
    return false;
  }
}

module.exports = { initialize, acquireFileLock, getLockPath, isJobCompleted };
