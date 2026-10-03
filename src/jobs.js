'use strict';

const vscode = require('vscode');
const { s } = require('./i18n');
const { truncate, errorText } = require('./utils');
const { resolveCodexRuntime, createCodexThread, runCodex, getWorkspaceCwdForCodex } = require('./runtime');
const jobLocks = require('./jobLocks');
const jobStore = require('./jobStore');
const { createJobTimers } = require('./jobTimers');

const RATE_LIMIT_RETRY_MS = 2 * 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 5;

let onChange;
let stopWatching;
const inFlight = new Set();

const timers = createJobTimers({
  getJobs: jobStore.getJobs,
  executeJob,
  recoverInterruptedJob,
  removeCompletedJobIfPresent,
  isInFlight: (jobId) => inFlight.has(jobId),
  onTimerError: (err) => vscode.window.showErrorMessage(s('sendFailed', { error: truncate(errorText(err), 220) }))
});

function initialize(context, callback) {
  stopWatching?.();
  onChange = callback;
  jobLocks.initialize(context);
  jobStore.initialize(context);

  stopWatching = jobStore.watchJobs(() => {
    timers.syncTimersWithJobs();
    notifyChanged();
  });
}

function notifyChanged() { onChange?.(); }

async function executeJob(jobId) {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  let job;
  let releaseExecutionLock;
  try {
    if (await removeCompletedJobIfPresent(jobId)) return;
    // Keep a per-job lock for the full Codex operation so another VS Code window cannot send it too.
    releaseExecutionLock = await jobLocks.acquireFileLock(`job:${jobId}`);
    if (!releaseExecutionLock) {
      if (await removeCompletedJobIfPresent(jobId)) return;
      const current = retryScheduledJob(jobId);
      if (current?.status === 'sending') timers.scheduleSendingRecovery(jobId);
      return;
    }
    const claimed = await jobStore.claimScheduledJob(jobId);
    if (claimed?.status === 'scheduled') {
      timers.scheduleTimer(claimed);
      return;
    }
    job = claimed;
    if (!job) return;
    notifyChanged();

    const runtime = await resolveCodexRuntime();
    job = await ensureJobThread(runtime, job);
    if (!job) return;

    const result = await runCodex(runtime, ['queue', '--thread', job.threadId, '--message', job.prompt], 60000);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.code}`).trim());
    await releaseExecutionLock.markCompleted();
    await removeJob(job.id);
    notifyChanged();
    vscode.window.showInformationMessage(s('sent'));
  } catch (err) {
    if (!job) {
      retryScheduledJob(jobId);
      throw err;
    }
    await handleSendFailure(job, err);
  } finally {
    if (releaseExecutionLock) await releaseExecutionLock();
    inFlight.delete(jobId);
  }
}

async function ensureJobThread(runtime, job) {
  if (job.threadMode !== 'new' || job.threadId) return job;
  const cwd = Object.hasOwn(job, 'cwd') ? job.cwd : getWorkspaceCwdForCodex?.() || null;
  const threadId = await createCodexThread(runtime, cwd);
  const updated = await jobStore.updateSendingJob(job.id, { threadId });
  if (updated) notifyChanged();
  return updated;
}

function retryScheduledJob(jobId) {
  const job = jobStore.getJobs().find((candidate) => candidate.id === jobId);
  if (job?.status === 'scheduled') timers.scheduleRetryTimer(job);
  return job;
}

async function handleSendFailure(job, error) {
  if (!jobStore.getJobs().some((candidate) => candidate.id === job.id)) return;
  const lastError = errorText(error);
  const attempts = (job.attempts || 0) + 1;
  const retry = isRateLimitError(lastError) && attempts <= MAX_RATE_LIMIT_RETRIES;
  const updated = {
    ...job, attempts, lastError,
    status: retry ? 'scheduled' : 'failed',
    sendAt: retry ? Date.now() + RATE_LIMIT_RETRY_MS : job.sendAt
  };
  await jobStore.upsertJob(updated);
  if (retry) timers.scheduleTimer(updated);
  notifyChanged();
  if (retry) vscode.window.showWarningMessage(s('stillLimited', { attempt: attempts, max: MAX_RATE_LIMIT_RETRIES }));
  else vscode.window.showErrorMessage(s('sendFailed', { error: truncate(lastError, 220) }));
}

async function recoverInterruptedJob(jobId) {
  if (await removeCompletedJobIfPresent(jobId)) return;
  const releaseExecutionLock = await jobLocks.acquireFileLock(`job:${jobId}`);
  if (!releaseExecutionLock) {
    if (await removeCompletedJobIfPresent(jobId)) return;
    timers.scheduleSendingRecovery(jobId);
    return;
  }
  try {
    const recovered = await jobStore.updateSendingJob(jobId, { status: 'failed', lastError: s('sendInterrupted') });
    if (recovered) notifyChanged();
  } finally {
    await releaseExecutionLock();
  }
}

function isRateLimitError(text) {
  return /(rate.?limit|usage.?limit|too many requests|\b429\b|quota)/i.test(text || '');
}

async function removeCompletedJobIfPresent(jobId) {
  if (!await jobLocks.isJobCompleted(jobId)) return false;
  if (jobStore.getJobs().some((job) => job.id === jobId)) {
    await removeJob(jobId);
    notifyChanged();
  }
  return true;
}

async function removeEditableJob(id) {
  const removed = await jobStore.removeEditableJob(id);
  if (removed) timers.cancel(id);
  return removed;
}

async function removeJob(id) {
  timers.cancel(id);
  await jobStore.removeJob(id);
}

function dispose() {
  stopWatching?.();
  stopWatching = undefined;
  timers.dispose();
}

module.exports = {
  initialize, notifyChanged, dispose, removeJob, removeEditableJob,
  restoreTimers: timers.restoreTimers,
  scheduleTimer: timers.scheduleTimer,
  getJobs: jobStore.getJobs,
  upsertJob: jobStore.upsertJob,
  updateEditableJob: jobStore.updateEditableJob
};
