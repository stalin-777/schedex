'use strict';

const fs = require('fs/promises');
const path = require('path');
const { acquireFileLock } = require('./jobLocks');
const { writeJsonAtomic } = require('./jobStore');
const { getAvailabilityContext, readAvailabilitySnapshot } = require('./runtime');
const { assessAvailability, classifyAvailabilityError, errorBackoff, MINUTE } = require('./availabilityPolicy');

let cachePath;
let memory;

function initialize(context) {
  cachePath = context.globalStorageUri?.fsPath ? path.join(context.globalStorageUri.fsPath, 'availability.v1.json') : null;
  memory = null;
}

async function readCache() {
  if (!cachePath) return memory;
  try { return JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch (_) { return null; }
}

async function writeCache(value) {
  if (cachePath) await writeJsonAtomic(cachePath, value);
  else memory = value;
}

function refreshAt(limits, now) {
  const blockedResets = [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId || {})]
    .filter(Boolean).flatMap((item) => [item.primary, item.secondary])
    .filter((window) => window && window.usedPercent >= 100)
    .map((window) => Number(window.resetsAt) * 1000).filter((time) => time > now);
  const nearest = blockedResets.length ? Math.min(...blockedResets) : null;
  const interval = limits.ordinaryUsageAllowed === true || (nearest && nearest - now <= 30 * MINUTE)
    ? 2 * MINUTE : 15 * MINUTE;
  return nearest ? Math.min(now + interval, nearest + MINUTE) : now + interval;
}

async function snapshot(runtime, key, requestedAt = 0) {
  const release = await acquireFileLock('availability-cache', 30000);
  if (!release) throw new Error('Availability cache busy');
  try {
    const previous = await readCache();
    const now = Date.now();
    if (previous?.key === key && previous.checkedAt >= requestedAt && previous.checkedAt <= now && previous.validUntil > now) return previous;
    let entry;
    try {
      const result = await readAvailabilitySnapshot(runtime);
      if (result.accountKey !== key) throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
      const checkedAt = Date.now();
      const limits = { ordinaryUsageAllowed: result.limits.ordinaryUsageAllowed,
        rateLimits: result.limits.rateLimits, rateLimitsByLimitId: result.limits.rateLimitsByLimitId };
      entry = { key, checkedAt, validUntil: refreshAt(limits, checkedAt), failures: 0, limits };
    } catch (error) {
      const failure = classifyAvailabilityError(error);
      const failures = previous?.key === key ? (previous.failures || 0) + 1 : 1;
      entry = { key, checkedAt: Date.now(), validUntil: Date.now() + errorBackoff(failures), failures, error: failure };
    }
    await writeCache(entry);
    return entry;
  } finally { await release(); }
}

async function check(runtime, job) {
  const context = await getAvailabilityContext(runtime, job);
  if (job.accountKey && job.accountKey !== context.accountKey) {
    throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
  }
  // A new or edited task must not wait on a blocked snapshot from before it was saved.
  // Concurrent tasks can still share a snapshot fetched after both were created.
  const entry = await snapshot(runtime, context.accountKey, Math.max(job.forceCheckAt || 0, job.availabilityRequestedAt || 0));
  if (entry.error) return { ready: false, accountKey: context.accountKey, checkedAt: entry.checkedAt,
    reason: entry.error.reason, permanent: entry.error.permanent, nextCheckAt: entry.validUntil, failures: entry.failures };
  const state = assessAvailability(entry.limits, context.model);
  if (!state.ready) state.nextCheckAt = Math.min(state.nextCheckAt, entry.validUntil);
  return { ...state, accountKey: context.accountKey, resolvedModel: context.model,
    checkedAt: entry.checkedAt, failures: 0 };
}

async function invalidate(key) {
  const release = await acquireFileLock('availability-cache', 30000);
  if (!release) throw new Error('Availability cache busy');
  try {
    const entry = await readCache();
    if (entry?.key === key) await writeCache({ ...entry, validUntil: 0 });
  } finally { await release(); }
}

module.exports = { initialize, check, invalidate };
