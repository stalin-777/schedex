'use strict';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_WAIT_DAYS = 8;
const MAX_SEND_ATTEMPTS = 5;

function nextWakeAt(job) {
  const due = job.sendMode === 'available' ? job.nextCheckAt ?? job.sendAt : job.nextAttemptAt ?? job.sendAt;
  return job.sendMode === 'available' && Number.isFinite(job.expiresAt) ? Math.min(due, job.expiresAt) : due;
}

function applicableLimits(result, model) {
  const byId = result?.rateLimitsByLimitId || {};
  const base = byId.codex || result?.rateLimits;
  const snapshots = [base, ...Object.entries(byId)
    .filter(([id, item]) => model && (id === model || item?.normalModelSlug === model))
    .map(([, item]) => item)];
  return [...new Set(snapshots.filter(Boolean))];
}

function blockedWindows(result, model) {
  return applicableLimits(result, model).flatMap((snapshot) => ['primary', 'secondary']
    .map((key) => snapshot[key]).filter((window) => window && Number(window.usedPercent) >= 100));
}

function resetSuggestion(result, model, now = Date.now()) {
  const blocked = blockedWindows(result, model);
  const windows = blocked.length ? blocked : applicableLimits(result, model)
    .flatMap((snapshot) => [snapshot.primary, snapshot.secondary])
    .filter((window) => window?.windowDurationMins === 300);
  const times = windows.map((window) => Number(window.resetsAt) * 1000).filter((time) => time > now);
  if (!times.length) return null;
  const resetAtMs = Math.max(...times);
  return { resetAtMs, sendAtMs: resetAtMs + MINUTE };
}

function assessAvailability(result, model, now = Date.now()) {
  const snapshots = applicableLimits(result, model);
  const blocked = blockedWindows(result, model);
  const future = blocked.map((window) => Number(window.resetsAt) * 1000).filter((time) => time > now);
  const resetAt = future.length ? Math.max(...future) : null;
  let reason = 'quota';
  if (blocked.some((window) => window.windowDurationMins === 10080)) reason = 'weekly';
  else if (blocked.some((window) => window.windowDurationMins === 300)) reason = 'fiveHour';
  const restricted = snapshots.some((snapshot) => snapshot.rateLimitReachedType || snapshot.spendControlReached === true
    || snapshot.individualLimit?.remainingPercent <= 0);
  if (!blocked.length && !restricted && result?.ordinaryUsageAllowed === true) return { ready: true };
  if (!blocked.length && !restricted && result?.ordinaryUsageAllowed !== false) reason = 'unknown';
  // Past reset timestamps never establish recovery, even in a freshly fetched response.
  const interval = resetAt && resetAt - now <= 30 * MINUTE ? 2 * MINUTE : 15 * MINUTE;
  return { ready: false, reason, resetAt, nextCheckAt: resetAt
    ? Math.min(now + interval, resetAt + MINUTE) : now + interval };
}

function classifyAvailabilityError(error) {
  if (['ACCOUNT_CHANGED', 'AUTH_REQUIRED', 'UNSUPPORTED_ACCOUNT', 'MODEL_UNAVAILABLE', 'INVALID_EFFORT'].includes(error.code)) {
    return { reason: error.code === 'ACCOUNT_CHANGED' ? 'accountChanged'
      : error.code === 'MODEL_UNAVAILABLE' || error.code === 'INVALID_EFFORT' ? 'model' : 'auth', permanent: true };
  }
  const text = String(error.message || error);
  if (error.code === -32601 || /method.*not found|unknown method/i.test(text)) return { reason: 'unknown', permanent: false };
  if (/\b(401|403)\b|authentication required|chatgpt authentication|not logged in|unauthorized|token.*expired/i.test(text)) {
    return { reason: 'auth', permanent: true };
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|dns|no internet|network.*(?:unreachable|offline)|connection.*(?:refused|reset)/i.test(error.code + ' ' + text)) {
    return { reason: 'network', permanent: false };
  }
  return { reason: 'service', permanent: false };
}

function errorBackoff(failures) {
  return [1, 2, 5, 15][Math.min(Math.max(failures - 1, 0), 3)] * MINUTE;
}

module.exports = { MINUTE, DAY, DEFAULT_WAIT_DAYS, MAX_SEND_ATTEMPTS, nextWakeAt,
  applicableLimits, blockedWindows, resetSuggestion, assessAvailability, classifyAvailabilityError, errorBackoff };
