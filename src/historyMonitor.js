'use strict';

const CHECK_INTERVAL = 30000;
const MAX_MONITOR_AGE = 8 * 24 * 60 * 60000;

function createHistoryMonitor({ getHistory, updateJobs, acquireLock, resolveRuntime, readProgress, onChange }) {
  let timer;
  let stopped = true;
  let currentCheck;
  let pendingForceAt = 0;

  function candidates(force = false) {
    return getHistory().filter((job) => (['queued', 'running', 'delivered', 'review'].includes(job.status)
      || (force && ['completed', 'failed', 'interrupted'].includes(job.status))
      || (job.status === 'interrupted' && !job.terminalStatusConfirmed))
      && (job.turnId || job.queuedSubmissionId || job.clientMessageId)
      && (force || Date.now() - job.archivedAt < MAX_MONITOR_AGE)
      && (force || job.status !== 'delivered' || job.clientMessageId || job.turnId));
  }

  function sync() {
    clearTimeout(timer);
    if (stopped || currentCheck) return;
    const jobs = candidates();
    if (!jobs.length) return;
    const next = Math.min(...jobs.map((job) => (job.lastStatusCheckAt || 0) + CHECK_INTERVAL));
    timer = setTimeout(() => refresh().catch((error) => console.error('Schedex history:', error)), Math.max(500, next - Date.now()));
  }

  async function check(requestedAt) {
    const force = requestedAt > 0;
    let release;
    try {
      release = await acquireLock('history-status', force ? 30000 : 0);
      if (!release) {
        if (force) throw new Error('History refresh is busy. Try again.');
        return;
      }
      const jobs = candidates(force).filter((job) => force ? (job.lastStatusCheckAt || 0) <= requestedAt
        : Date.now() - (job.lastStatusCheckAt || 0) >= CHECK_INTERVAL)
        .sort((a, b) => (a.lastStatusCheckAt || 0) - (b.lastStatusCheckAt || 0)).slice(0, 100);
      if (!jobs.length) return;
      let updates;
      try { updates = await readProgress(await resolveRuntime(), jobs, () => stopped); }
      catch (error) {
        updates = jobs.map((job) => ({ id: job.id, changes: {
          statusError: String(error.message || error).slice(0, 2000), lastStatusCheckAt: Date.now()
        } }));
      }
      if (stopped) return;
      await updateJobs(updates);
      if (!stopped) onChange();
    } finally {
      if (release) await release();
    }
  }

  function refresh(force = false) {
    if (stopped) return Promise.resolve();
    if (currentCheck) {
      if (force) pendingForceAt = Date.now();
      return currentCheck;
    }
    currentCheck = (async () => {
      let requestedAt = force ? Date.now() : 0;
      do {
        pendingForceAt = 0;
        await check(requestedAt);
        requestedAt = pendingForceAt;
      } while (requestedAt && !stopped);
    })().finally(() => { currentCheck = undefined; sync(); });
    return currentCheck;
  }

  return { start() { stopped = false; sync(); }, sync, refresh,
    dispose() { stopped = true; clearTimeout(timer); } };
}

module.exports = { createHistoryMonitor };
