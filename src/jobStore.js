'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { acquireFileLock } = require('./jobLocks');
const { retryFileOperation } = require('./fileRetry');
const { nextWakeAt, DAY, DEFAULT_WAIT_DAYS } = require('./availabilityPolicy');
const { MAX_STORE_BYTES, HISTORY_PAGE_SIZE } = require('./limits');

const JOBS_KEY = 'schedex.jobs.v1';
const JOBS_LOCK_WAIT_MS = 30 * 1000;

let extContext;
let writes = Promise.resolve();

function initialize(context) {
  extContext = context;
}

function getAllJobs() {
  if (!extContext) return [];
  try {
    return readJobs();
  } catch (err) {
    console.error('Schedex could not read its job store:', err);
    return [];
  }
}

function getJobs() { return getAllJobs().filter((job) => !job.archivedAt); }

function getHistory() {
  return getAllJobs().filter((job) => job.archivedAt).sort((a, b) => b.archivedAt - a.archivedAt);
}

function getSnapshot(page = 0) {
  const all = getAllJobs();
  const history = all.filter((job) => job.archivedAt).sort((a, b) => b.archivedAt - a.archivedAt);
  const historyPage = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, Math.ceil(history.length / HISTORY_PAGE_SIZE) - 1));
  return { jobs: all.filter((job) => !job.archivedAt), history: history.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE),
    historyPage, historyTotal: history.length, historyPageSize: HISTORY_PAGE_SIZE };
}

function getLegacyJobs() {
  const jobs = extContext?.globalState.get(JOBS_KEY, []);
  return Array.isArray(jobs) ? jobs.slice() : [];
}

function getJobsFilePath() {
  const storagePath = extContext?.globalStorageUri?.fsPath;
  // globalState remains the migration source only; this shared file is the live job store.
  return storagePath ? path.join(storagePath, 'schedex.jobs.v1.json') : null;
}

function readJobs(filePath = getJobsFilePath()) {
  if (filePath) {
    try {
      if (fsSync.statSync(filePath).size > MAX_STORE_BYTES) throw new Error('Schedex job store exceeds 16 MiB');
      const jobs = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(jobs)) throw new Error('Schedex job store must contain a JSON array');
      return jobs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return getLegacyJobs();
}

function watchJobs(onChange) {
  const filePath = getJobsFilePath();
  if (!filePath) return () => {};
  const context = extContext;
  const folder = path.dirname(filePath);
  let watcher;
  let stopped = false;
  fs.mkdir(folder, { recursive: true }).then(() => {
    if (stopped || extContext !== context) return;
    watcher = fsSync.watch(folder, (_eventType, filename) => {
      if (!filename || filename.toString() === path.basename(filePath)) onChange();
    });
    watcher.on('error', (err) => console.error('Schedex job-store watcher failed:', err));
    onChange();
  }).catch((err) => console.error('Schedex could not watch its job store:', err));
  return () => {
    stopped = true;
    watcher?.close();
  };
}

async function writeJsonAtomic(filePath, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('Schedex storage limit reached (16 MiB). Clear finished history or remove templates.');
  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await retryFileOperation(() => fs.rename(tempPath, filePath));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await retryFileOperation(() => fs.unlink(tempPath)).catch(() => {});
  }
}

function updateJobs(mutator) {
  const next = writes.then(async () => {
    if (!extContext) return;
    // The in-memory queue only covers this extension host; the file lock serializes other windows.
    const release = await acquireFileLock('jobs', JOBS_LOCK_WAIT_MS);
    if (!release) throw new Error('Timed out waiting for the Schedex job storage lock');
    try {
      const filePath = getJobsFilePath();
      const jobs = readJobs(filePath);
      const result = mutator(jobs);
      if (filePath) {
        await writeJsonAtomic(filePath, jobs);
      } else {
        await extContext.globalState.update(JOBS_KEY, jobs);
      }
      return result;
    } finally {
      await release();
    }
  });
  writes = next.catch(() => {});
  return next;
}

function upsertJob(job) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((x) => x.id === job.id);
    if (index >= 0) jobs[index] = job; else jobs.push(job);
  });
}

function updateEditableJob(id, changes) {
  return updateJob(id, (job) => ({
    nextCheckAt: job.sendMode === 'available' ? Date.now() : null,
    expiresAt: job.sendMode === 'available' && job.expiresAt <= Date.now()
      ? Date.now() + (job.waitDays || DEFAULT_WAIT_DAYS) * DAY : job.expiresAt,
    ...changes, status: 'scheduled', attempts: 0, lastError: null, turnId: null,
    nextAttemptAt: null, submissionStartedAt: null, waitReason: null, checkFailures: 0,
    accountKey: changes.accountKey ?? job.accountKey,
    clientMessageId: null, queuedSubmissionId: null, acceptedAt: null, startedAt: null, finishedAt: null,
    pendingRevision: null, confirmationId: null,
    // Preserve proof of the old split-process failure before clearing its error on retry.
    ...(job.threadMode === 'new' && job.threadInitialized == null && !job.turnId
      && /no rollout found/i.test(job.lastError || '') ? { threadInitialized: false } : {})
  }), isEditable);
}

function updateSendingJob(id, changes) {
  return updateJob(id, changes, (job) => job.status === 'sending');
}

function requestAvailabilityCheck(id) {
  const now = Date.now();
  return updateJob(id, { nextCheckAt: now, forceCheckAt: now },
    (job) => !job.archivedAt && job.sendMode === 'available' && job.status === 'scheduled');
}

function updateActiveJob(id, changes) {
  return updateJob(id, changes, (job) => ['checking', 'sending'].includes(job.status));
}

function archiveActiveJob(id, changes) {
  return updateJob(id, { ...changes, archivedAt: Date.now(), waitReason: null, lastError: null },
    (job) => !job.archivedAt);
}

function updateHistoryJob(id, changes) {
  return updateJob(id, changes, (job) => Boolean(job.archivedAt));
}

function updateHistoryJobs(updates) {
  return updateJobs((jobs) => {
    const byId = new Map(updates.map((update) => [update.id, update.changes]));
    for (const job of jobs) if (job.archivedAt && byId.has(job.id)) Object.assign(job, byId.get(job.id));
  });
}

function pruneHistory(days) {
  if (!Number.isInteger(days) || days <= 0) return Promise.resolve();
  return updateJobs((jobs) => {
    const cutoff = Date.now() - days * DAY;
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      if (job.archivedAt && job.archivedAt < cutoff && (['completed', 'failed', 'cancelled'].includes(job.status)
        || (job.status === 'interrupted' && job.terminalStatusConfirmed))) jobs.splice(i, 1);
    }
  });
}

function clearFinishedHistory() {
  return updateJobs((jobs) => {
    for (let index = jobs.length - 1; index >= 0; index--) {
      if (jobs[index].archivedAt && ['completed', 'failed', 'interrupted', 'cancelled'].includes(jobs[index].status)) jobs.splice(index, 1);
    }
  });
}

function resolveStaleJob(id, confirmationId, decision) {
  if (!['send', 'skip'].includes(decision) || typeof confirmationId !== 'string') return null;
  return updateJob(id, (job) => {
    const expired = job.sendMode === 'available' && job.expiresAt <= Date.now();
    return { status: expired ? 'expired' : decision === 'skip' ? 'skipped' : 'scheduled',
      threadRevision: decision === 'send' ? job.pendingRevision : job.threadRevision,
      pendingRevision: null, confirmationId: null, lastError: null,
      waitReason: expired ? 'expired' : decision === 'skip' ? 'changed' : null,
      nextCheckAt: Date.now(), nextAttemptAt: Date.now() };
  }, (job) => job.status === 'confirmation' && job.confirmationId === confirmationId);
}

function beginSending(id) {
  return updateJobs((jobs) => {
    const job = jobs.find((candidate) => candidate.id === id && candidate.status === 'checking');
    if (!job) return null;
    if (job.expiresAt <= Date.now()) Object.assign(job, { status: 'expired', waitReason: 'expired' });
    else Object.assign(job, { status: 'sending', waitReason: null, nextCheckAt: null });
    return { ...job };
  });
}

function updateJob(id, changes, canUpdate) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && canUpdate(job));
    if (index < 0) return null;
    const patch = typeof changes === 'function' ? changes(jobs[index]) : changes;
    jobs[index] = { ...jobs[index], ...patch, id };
    return jobs[index];
  });
}

function claimScheduledJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && job.status === 'scheduled');
    if (index < 0) return null;
    // Recheck under the storage lock: another window may have postponed this job.
    if (nextWakeAt(jobs[index]) > Date.now()) return jobs[index];
    const available = jobs[index].sendMode === 'available';
    const expired = available && jobs[index].expiresAt <= Date.now();
    jobs[index] = { ...jobs[index], status: expired ? 'expired' : available ? 'checking' : 'sending',
      ...(expired ? { waitReason: 'expired' } : {}) };
    return jobs[index];
  });
}

function isEditable(job) {
  return !job.archivedAt && ['scheduled', 'failed', 'paused', 'expired', 'review', 'confirmation', 'skipped'].includes(job.status);
}

function removeEditableJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && isEditable(job));
    if (index < 0) return false;
    const job = jobs[index];
    const outcome = job.status === 'review'
      ? { trackingUnknown: true, terminalStatusConfirmed: false }
      : { status: 'cancelled', finishedAt: Date.now() };
    jobs[index] = { ...job, ...outcome, archivedAt: Date.now() };
    return true;
  });
}

function removeJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((x) => x.id === id);
    if (index >= 0) jobs.splice(index, 1);
  });
}

module.exports = {
  initialize,
  getJobs,
  getHistory,
  getSnapshot,
  updateHistoryJobs,
  pruneHistory,
  getJobsFilePath,
  watchJobs,
  updateJobs,
  claimScheduledJob,
  updateSendingJob,
  updateActiveJob,
  archiveActiveJob,
  updateHistoryJob,
  clearFinishedHistory,
  resolveStaleJob,
  beginSending,
  writeJsonAtomic,
  upsertJob,
  updateEditableJob,
  requestAvailabilityCheck,
  isEditable,
  removeEditableJob,
  removeJob
};
