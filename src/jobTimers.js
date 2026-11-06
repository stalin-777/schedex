'use strict';

const { nextWakeAt } = require('./availabilityPolicy');

const LOCK_RETRY_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 0x7fffffff;

function createJobTimers({ getJobs, executeJob, recoverInterruptedJob, removeCompletedJobIfPresent, isInFlight, onTimerError }) {
  const scheduled = new Map();
  const recovery = new Map();
  let stopped = false;

  function clearTimer(collection, jobId) {
    const timer = collection.get(jobId);
    if (timer) clearTimeout(timer.handle);
    collection.delete(jobId);
  }

  function scheduleTimer(job, wakeAt = nextWakeAt(job)) {
    if (stopped) return;
    clearTimer(scheduled, job.id);
    const delay = Math.max(0, wakeAt - Date.now());
    const handle = setTimeout(async () => {
      scheduled.delete(job.id);
      const fresh = getJobs().find((candidate) => candidate.id === job.id);
      if (stopped || fresh?.status !== 'scheduled') return;
      if (delay > MAX_TIMEOUT_MS || nextWakeAt(fresh) > Date.now()) return scheduleTimer(fresh);
      try {
        await executeJob(job.id);
      } catch (err) {
        onTimerError(err);
      }
    }, Math.min(delay, MAX_TIMEOUT_MS));
    scheduled.set(job.id, { handle, wakeAt: nextWakeAt(job) });
  }

  function scheduleSendingRecovery(jobId) {
    if (stopped) return;
    clearTimer(recovery, jobId);
    const handle = setTimeout(async () => {
      recovery.delete(jobId);
      if (stopped || !getJobs().some((job) => job.id === jobId && ['checking', 'sending'].includes(job.status))) return;
      try {
        await recoverInterruptedJob(jobId);
      } catch (err) {
        scheduleSendingRecovery(jobId);
        onTimerError(err);
      }
    }, LOCK_RETRY_MS);
    recovery.set(jobId, { handle });
  }

  function scheduleRetryTimer(job) {
    // The wake-up time changes; the stored due time still identifies edits from other windows.
    scheduleTimer(job, Date.now() + LOCK_RETRY_MS);
  }

  function syncTimersWithJobs() {
    if (stopped) return;
    const jobs = getJobs();
    const scheduledJobs = new Map(jobs.filter((job) => job.status === 'scheduled').map((job) => [job.id, job]));
    const sendingIds = new Set(jobs.filter((job) => ['checking', 'sending'].includes(job.status)).map((job) => job.id));
    for (const [jobId, timer] of scheduled) {
      const job = scheduledJobs.get(jobId);
      if (!job || timer.wakeAt !== nextWakeAt(job)) clearTimer(scheduled, jobId);
    }
    for (const job of scheduledJobs.values()) {
      if (!scheduled.has(job.id) && !isInFlight(job.id)) scheduleTimer(job);
    }
    for (const jobId of recovery.keys()) {
      if (!sendingIds.has(jobId)) clearTimer(recovery, jobId);
    }
    for (const jobId of sendingIds) {
      if (!recovery.has(jobId)) scheduleSendingRecovery(jobId);
    }
  }

  async function restoreTimers() {
    for (const job of getJobs()) {
      if (await removeCompletedJobIfPresent(job.id)) continue;
      if (job.status === 'scheduled') scheduleTimer(job);
      if (['checking', 'sending'].includes(job.status)) {
        try {
          await recoverInterruptedJob(job.id);
        } catch (err) {
          scheduleSendingRecovery(job.id);
          onTimerError(err);
        }
      }
    }
  }

  function cancel(jobId) {
    clearTimer(scheduled, jobId);
    clearTimer(recovery, jobId);
  }

  function dispose() {
    stopped = true;
    for (const collection of [scheduled, recovery]) {
      for (const jobId of collection.keys()) clearTimer(collection, jobId);
    }
  }

  return { start: () => { stopped = false; }, scheduleTimer, scheduleRetryTimer, scheduleSendingRecovery,
    syncTimersWithJobs, restoreTimers, cancel, dispose };
}

module.exports = { createJobTimers };
