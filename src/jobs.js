'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { s } = require('./i18n');
const { truncate, errorText } = require('./utils');
const { resolveCodexRuntime, queuePrompt, getAccountKey, getWorkspaceCwdForCodex, getThreadRevision, readHistoryProgress } = require('./runtime');
const jobLocks = require('./jobLocks');
const jobStore = require('./jobStore');
const { createJobTimers } = require('./jobTimers');
const directDelivery = require('./directDelivery');
const availability = require('./availability');
const { createHistoryMonitor } = require('./historyMonitor');
const { accountKey } = require('./accountIdentity');
const { MAX_SEND_ATTEMPTS, errorBackoff, classifyAvailabilityError } = require('./availabilityPolicy');
const { validatePrompt } = require('./limits');

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

const historyMonitor = createHistoryMonitor({
  getHistory: jobStore.getHistory, updateJobs: jobStore.updateHistoryJobs,
  acquireLock: jobLocks.acquireFileLock, resolveRuntime: resolveCodexRuntime,
  readProgress: readHistoryProgress, onChange: notifyChanged
});

function initialize(context, callback) {
  stopWatching?.();
  onChange = callback;
  jobLocks.initialize(context);
  jobStore.initialize(context);
  availability.initialize(context);
  timers.start();
  historyMonitor.start();

  stopWatching = jobStore.watchJobs(() => {
    timers.syncTimersWithJobs();
    historyMonitor.sync();
    notifyChanged();
  });
}

function notifyChanged() { onChange?.(); }

async function executeJob(jobId) {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  let job;
  let releaseExecutionLock;
  let releaseAvailability;
  let releaseThread;
  let confirmation;
  try {
    if (await removeCompletedJobIfPresent(jobId)) return;
    // Keep a per-job lock for the full Codex operation so another VS Code window cannot send it too.
    releaseExecutionLock = await jobLocks.acquireFileLock(`job:${jobId}`);
    if (!releaseExecutionLock) {
      if (await removeCompletedJobIfPresent(jobId)) return;
      const current = retryScheduledJob(jobId);
      if (['checking', 'sending'].includes(current?.status)) timers.scheduleSendingRecovery(jobId);
      return;
    }
    const claimed = await jobStore.claimScheduledJob(jobId);
    if (claimed?.status === 'scheduled') {
      timers.scheduleTimer(claimed);
      return;
    }
    job = claimed;
    if (!job || job.status === 'expired') { notifyChanged(); return; }
    notifyChanged();

    if (job.threadMode !== 'new' && (job.model || job.reasoningEffort)) {
      await settleJob(job, { status: 'paused', waitReason: 'threadSettings', lastError: s('legacyThreadModelHelp') });
      return;
    }
    const runtime = await resolveCodexRuntime();
    validatePrompt(job.prompt || '');
    if (!job.accountKey) throw Object.assign(new Error(s('wait_accountMissing')), { code: 'ACCOUNT_UNBOUND' });
    if (job.sendMode !== 'available' && await getAccountKey(runtime) !== job.accountKey) {
      throw Object.assign(new Error(s('wait_accountChanged')), { code: 'ACCOUNT_CHANGED' });
    }
    if (job.sendMode === 'available') {
      releaseAvailability = await jobLocks.acquireFileLock('availability-dispatch');
      if (!releaseAvailability) {
        await settleJob(job, { status: 'scheduled', waitReason: 'checking', nextCheckAt: Date.now() + 30000 });
        return;
      }
      const result = await availability.check(runtime, job);
      job = await jobStore.updateActiveJob(job.id, { accountKey: result.accountKey,
        lastCheckedAt: result.checkedAt, checkFailures: result.failures, estimatedResetAt: result.resetAt || null,
        resolvedModel: result.resolvedModel || null });
      if (!job) return;
      if (!result.ready) {
        await settleJob(job, { status: result.permanent ? 'paused' : 'scheduled', waitReason: result.reason,
          nextCheckAt: result.nextCheckAt, lastError: null });
        return;
      }
      job = await jobStore.beginSending(job.id);
      if (!job || job.status !== 'sending') { notifyChanged(); return; }
    }

    async function beforeSubmit(client, target) {
      if (job.sendMode === 'available') {
        // Queue delivery goes through Codex's existing server. Re-read its saved
        // target settings without trying to take ownership of the conversation.
        if (job.resolvedModel && target?.model && job.resolvedModel !== target.model) {
          throw Object.assign(new Error('Conversation model changed'), { code: 'MODEL_CHANGED' });
        }
        if (Date.now() >= job.expiresAt) throw Object.assign(new Error(s('wait_expired')), { code: 'WAIT_EXPIRED' });
        if ((job.attempts || 0) >= MAX_SEND_ATTEMPTS) throw Object.assign(new Error(s('wait_attempts')), { code: 'MAX_ATTEMPTS' });
      }
      if (job.threadMode !== 'new' && ['skip', 'confirm'].includes(job.stalePolicy)) {
        if (!job.threadRevision) throw Object.assign(new Error(s('snapshotMissing')), { code: 'HISTORY_UNAVAILABLE' });
        let revision;
        try { revision = await getThreadRevision(runtime, job.threadId); }
        catch (_) { throw Object.assign(new Error(s('snapshotFailed')), { code: 'HISTORY_UNAVAILABLE' }); }
        if (revision !== job.threadRevision) throw Object.assign(new Error(s('conversationChanged')), { code: 'THREAD_CHANGED', revision });
      }
      if (job.sendMode === 'available' && Date.now() >= job.expiresAt) {
        throw Object.assign(new Error(s('wait_expired')), { code: 'WAIT_EXPIRED' });
      }
      const key = client ? accountKey(await client.request('account/read', {})) : await getAccountKey(runtime);
      if (key !== job.accountKey) throw Object.assign(new Error(s('wait_accountChanged')), { code: 'ACCOUNT_CHANGED' });
      job = await jobStore.updateSendingJob(job.id, { submissionStartedAt: Date.now(),
        clientMessageId: job.clientMessageId || null, attempts: (job.attempts || 0) + 1 });
      if (!job) throw new Error(s('jobChanged'));
    }
    if (job.threadMode === 'new' && !Object.hasOwn(job, 'cwd')) {
      job = { ...job, cwd: getWorkspaceCwdForCodex?.() || null };
    }
    const direct = job.threadMode === 'new';
    async function lockThread(threadId) {
      releaseThread = await jobLocks.acquireFileLock(`thread:${threadId}`, direct ? 0 : 500);
      if (!releaseThread) throw Object.assign(new Error(s('threadBusy')), { code: 'THREAD_BUSY', submissionRejected: true });
    }
    // A queued follow-up must not race a direct turn owned by another Schedex job.
    if (job.threadId) await lockThread(job.threadId);
    if (direct) {
      await directDelivery.deliverDirect(runtime, job, async (turnId) => {
        const started = { turnId, threadInitialized: true, acceptedAt: Date.now(), startedAt: Date.now() };
        job = { ...job, ...started };
        await jobStore.updateSendingJob(job.id, started);
        notifyChanged();
        if (releaseAvailability) {
          try { await availability.invalidate(job.accountKey); }
          finally { await releaseAvailability(); releaseAvailability = undefined; }
        }
      }, async (threadId) => {
        if (releaseThread) await releaseThread();
        await lockThread(threadId);
        job = { ...job, threadId, threadInitialized: false };
        await jobStore.updateSendingJob(job.id, { threadId, threadInitialized: false });
        notifyChanged();
      }, beforeSubmit);
    } else {
      job = { ...job, clientMessageId: crypto.randomUUID() };
      const receipt = await queuePrompt(runtime, job, beforeSubmit);
      job = await jobStore.updateSendingJob(job.id, { acceptedAt: Date.now(), queuedSubmissionId: receipt.id,
        clientMessageId: receipt.clientUserMessageId || job.clientMessageId });
      if (!job) throw new Error(s('jobChanged'));
      if (releaseAvailability) await availability.invalidate(job.accountKey);
    }
    // The turn/queue receipt is already persisted. Record durable completion
    // ownership before archiving so no unfinished writes follow disappearance
    // from the active list. A queue receipt confirms delivery, not completion.
    await releaseExecutionLock.markCompleted();
    await jobStore.archiveActiveJob(job.id, { status: direct ? 'completed' : job.queuedSubmissionId ? 'queued' : 'delivered',
      terminalStatusConfirmed: direct, finishedAt: direct ? Date.now() : null });
    timers.cancel(job.id);
    historyMonitor.sync();
    notifyChanged();
    vscode.window.showInformationMessage(s('sent'));
  } catch (err) {
    if (!job) {
      retryScheduledJob(jobId);
      throw err;
    }
    const updated = await handleSendFailure(job, err);
    if (updated?.status === 'confirmation') confirmation = updated;
  } finally {
    try {
      await releaseLocks(releaseAvailability, releaseThread, releaseExecutionLock);
    } finally {
      inFlight.delete(jobId);
      // An edit or immediate retry may consume its timer while this run is
      // finishing. Reconcile after dropping the local execution guard.
      timers.syncTimersWithJobs();
      if (confirmation) requestStaleConfirmation(confirmation).catch((error) => console.error('Schedex confirmation:', error));
    }
  }
}

async function releaseLocks(...releases) {
  let error;
  for (const release of releases) {
    try { await release?.(); }
    catch (failure) { error ??= failure; }
  }
  if (error) throw error;
}

async function settleJob(job, changes) {
  const updated = await jobStore.updateActiveJob(job.id, changes);
  if (updated?.status === 'scheduled') timers.scheduleTimer(updated);
  notifyChanged();
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
  if (!job.submissionStartedAt && !job.turnId && !error.turnId && !error.submissionAttempted
    && ['ACCOUNT_CHANGED', 'ACCOUNT_UNBOUND', 'AUTH_REQUIRED', 'UNSUPPORTED_ACCOUNT', 'PROMPT_TOO_LARGE'].includes(error.code)) {
    return settleJob(job, { status: 'paused', waitReason: error.code === 'ACCOUNT_CHANGED' ? 'accountChanged'
      : error.code === 'ACCOUNT_UNBOUND' ? 'accountMissing' : error.code === 'PROMPT_TOO_LARGE' ? 'promptSize' : 'auth',
    lastError, submissionStartedAt: null });
  }
  if (error.code === 'THREAD_CHANGED') {
    return settleJob(job, { status: job.stalePolicy === 'confirm' ? 'confirmation' : 'skipped',
      waitReason: 'changed', pendingRevision: error.revision,
      confirmationId: crypto.randomUUID(), lastError: null });
  }
  if (error.code === 'HISTORY_UNAVAILABLE') {
    return settleJob(job, { status: 'paused', waitReason: 'history', lastError });
  }
  if ((job.submissionStartedAt || error.submissionAttempted || job.turnId || error.turnId)
    && !error.submissionRejected && !error.turnCompleted) {
    await settleJob(job, { status: 'review', lastError, waitReason: 'review' });
    vscode.window.showWarningMessage(s('reviewNeeded'));
    return;
  }
  if (job.sendMode === 'available') {
    const expired = Date.now() >= job.expiresAt || error.code === 'WAIT_EXPIRED';
    const exhausted = (job.attempts || 0) >= MAX_SEND_ATTEMPTS || error.code === 'MAX_ATTEMPTS';
    const kind = error.code === 'THREAD_BUSY' ? { reason: 'busy' } : error.code === 'MODEL_CHANGED' ? { reason: 'checking' }
      : isRateLimitError(lastError) ? { reason: 'quota' } : classifyAvailabilityError(error);
    const failures = ['network', 'service'].includes(kind.reason) ? (job.checkFailures || 0) + 1 : 0;
    await settleJob(job, { status: expired ? 'expired' : exhausted || kind.permanent || error.turnCompleted ? 'paused' : 'scheduled',
      waitReason: expired ? 'expired' : exhausted ? 'attempts' : kind.reason, checkFailures: failures,
      submissionStartedAt: null, nextCheckAt: Date.now() + (kind.reason === 'busy' ? 30000
        : kind.reason === 'unknown' ? 15 * 60000 : errorBackoff(failures || 1)),
      lastError: error.turnCompleted ? lastError : null });
    return;
  }
  if (error.code === 'THREAD_BUSY') {
    await settleJob(job, { status: 'scheduled', nextAttemptAt: Date.now() + 30000, submissionStartedAt: null, lastError });
    return;
  }
  const attempts = job.submissionStartedAt ? job.attempts : (job.attempts || 0) + 1;
  const retry = !job.turnId && !error.turnId && !error.submissionAttempted
    && isRateLimitError(lastError) && attempts <= MAX_RATE_LIMIT_RETRIES;
  const updated = {
    ...job, attempts, lastError,
    status: retry ? 'scheduled' : 'failed',
    nextAttemptAt: retry ? Date.now() + RATE_LIMIT_RETRY_MS : null,
    submissionStartedAt: null
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
  inFlight.add(jobId);
  try {
    const job = jobStore.getJobs().find((candidate) => candidate.id === jobId);
    if (!job || !['checking', 'sending'].includes(job.status)) return;
    if (job.queuedSubmissionId && job.acceptedAt) {
      await jobStore.archiveActiveJob(job.id, { status: 'queued' });
      await releaseExecutionLock.markCompleted();
      historyMonitor.sync();
      return;
    }
    if (job.sendMode === 'available' && !job.submissionStartedAt && !job.turnId) {
      await jobStore.updateActiveJob(job.id, { status: job.expiresAt <= Date.now() ? 'expired' : 'scheduled',
        nextCheckAt: Date.now(), waitReason: job.expiresAt <= Date.now() ? 'expired' : 'checking' });
    } else {
      await settleJob(job, { status: job.submissionStartedAt || job.turnId ? 'review' : 'failed',
        waitReason: 'review', lastError: s('sendInterrupted') });
    }
  } finally {
    try { await releaseExecutionLock(); }
    finally {
      inFlight.delete(jobId);
      timers.syncTimersWithJobs();
      notifyChanged();
    }
  }
}

async function resolveStaleJob(jobId, confirmationId, decision) {
  const job = await jobStore.resolveStaleJob(jobId, confirmationId, decision);
  if (job?.status === 'scheduled') timers.scheduleTimer(job);
  notifyChanged();
}

async function requestStaleConfirmation(job) {
  const answer = await vscode.window.showWarningMessage(s('confirmChanged', { thread: job.threadName || job.threadId,
    prompt: truncate(job.prompt, 160) }), s('sendOnce'), s('skipSend'));
  if (answer === s('sendOnce') || answer === s('skipSend')) {
    await resolveStaleJob(job.id, job.confirmationId, answer === s('sendOnce') ? 'send' : 'skip');
  }
}

function isRateLimitError(text) {
  return /(rate.?limit|usage.?limit|too many requests|\b429\b|quota)/i.test(text || '');
}

async function removeCompletedJobIfPresent(jobId) {
  if (!await jobLocks.isJobCompleted(jobId)) return false;
  const job = jobStore.getJobs().find((item) => item.id === jobId);
  if (job) {
    timers.cancel(jobId);
    const completed = job.threadMode === 'new' && Boolean(job.turnId);
    await jobStore.archiveActiveJob(jobId, { status: completed ? 'completed' : job.queuedSubmissionId ? 'queued' : 'delivered',
      terminalStatusConfirmed: completed });
    notifyChanged();
  }
  return true;
}

async function removeEditableJob(id) {
  const removed = await jobStore.removeEditableJob(id);
  if (removed) {
    timers.cancel(id);
    historyMonitor.sync();
  }
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
  historyMonitor.dispose();
  directDelivery.dispose();
}

module.exports = {
  initialize, notifyChanged, dispose, removeJob, removeEditableJob, resolveStaleJob,
  restoreTimers: timers.restoreTimers,
  scheduleTimer: timers.scheduleTimer,
  getJobs: jobStore.getJobs,
  getHistory: jobStore.getHistory,
  getSnapshot: jobStore.getSnapshot,
  pruneHistory: jobStore.pruneHistory,
  refreshHistory: () => historyMonitor.refresh(true),
  clearFinishedHistory: async () => { await jobStore.clearFinishedHistory(); notifyChanged(); },
  upsertJob: jobStore.upsertJob,
  requestAvailabilityCheck: jobStore.requestAvailabilityCheck,
  updateEditableJob: jobStore.updateEditableJob
};
