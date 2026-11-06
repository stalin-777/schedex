'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');
const { readTaskProgress } = require('../src/taskProgress');

test('refreshing an absent old turn retains completion and eligibility for clearing history', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-old-result-'));
  const host = createJobHost(folder, { runtime: {
    getTaskProgress: async (_runtime, job) => readTaskProgress(async () => ({ data: [] }), job)
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  await host.jobs.upsertJob({ id: 'old', status: 'completed', threadId: 'thread', turnId: 'old-turn',
    archivedAt: Date.now() - 9 * 86400000, finishedAt: 20000, terminalStatusConfirmed: true });
  await host.jobs.refreshHistory();
  const refreshed = host.jobs.getHistory()[0];
  assert.equal(refreshed.status, 'completed');
  assert.equal(refreshed.finishedAt, 20000);
  assert.ok(refreshed.lastStatusCheckAt);
  await host.jobs.clearFinishedHistory();
  assert.deepEqual(host.jobs.getHistory(), []);
});

test('delivery receipts persist, progress updates across windows, and no history task is resubmitted', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-history-'));
  let sent = 0;
  let reads = 0;
  let status = 'queued';
  const runtime = {
    queuePrompt: async () => { sent++; return { id: 'queue-1' }; },
    getTaskProgress: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 20)); return { status, clientMessageId: 'message-1' }; }
  };
  const a = createJobHost(folder, { runtime });
  const b = createJobHost(folder, { runtime });
  t.after(async () => { a.jobs.dispose(); b.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'history', threadMode: 'existing', threadId: 'thread', prompt: 'Run', status: 'scheduled', sendAt: Date.now() };
  await a.jobs.upsertJob(job); a.jobs.scheduleTimer(job);
  await a.waitFor(() => a.jobs.getHistory().some((item) => item.id === job.id && item.status === 'queued'), undefined,
    () => ({ sent, reads, otherWindowNotifications: b.notifications }));
  assert.equal(a.jobs.getHistory()[0].queuedSubmissionId, 'queue-1');
  assert.equal(a.jobs.getHistory()[0].status, 'queued');
  await Promise.all([a.jobs.refreshHistory(), b.jobs.refreshHistory()]);
  assert.equal(reads, 1);
  status = 'running'; await a.jobs.refreshHistory();
  assert.equal(b.jobs.getHistory()[0].status, 'running');
  status = 'completed'; await b.jobs.refreshHistory();
  assert.equal(a.jobs.getHistory()[0].status, 'completed');
  await a.jobs.restoreTimers(); await b.jobs.restoreTimers();
  assert.equal(sent, 1);
  await a.jobs.clearFinishedHistory();
  assert.equal(b.jobs.getHistory().length, 0);
});

for (const operation of ['open', 'unlink', 'rename', 'writeFile']) {
  test(`two-window queue delivery survives a transient ${operation} sharing violation`, async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-history-sharing-'));
    let lockPath;
    let failed = false;
    let sends = 0;
    const io = { ...fs, [operation]: async (...args) => {
      const affected = operation === 'rename'
        ? args[1] === path.join(folder, 'schedex.jobs.v1.json')
        : args[0] === lockPath;
      if (affected && !failed) {
        failed = true;
        throw Object.assign(new Error('Transient sharing violation'), { code: 'EPERM' });
      }
      return fs[operation](...args);
    } };
    const runtime = { queuePrompt: async () => { sends++; return { id: 'queue-1' }; } };
    const a = createJobHost(folder, { runtime, io });
    const b = createJobHost(folder, { runtime, io });
    t.after(async () => { a.jobs.dispose(); b.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
    lockPath = a.locks.getLockPath(operation === 'writeFile' ? 'job:sharing-writeFile' : 'jobs');
    const job = { id: 'sharing-' + operation, threadMode: 'existing', threadId: 'thread', prompt: 'Run once',
      status: 'scheduled', sendAt: Date.now() };
    await a.jobs.upsertJob(job); a.jobs.scheduleTimer(job);
    await a.waitFor(() => a.jobs.getHistory().some((item) => item.id === job.id && item.status === 'queued'));
    assert.equal(failed, true);
    assert.equal(sends, 1);
    assert.equal(b.jobs.getHistory()[0].queuedSubmissionId, 'queue-1');
    await Promise.all([a.jobs.restoreTimers(), b.jobs.restoreTimers()]);
    assert.equal(sends, 1);
  });
}

test('removing a pending task archives cancellation and clearing finished history preserves queued work', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-cancel-history-'));
  const host = createJobHost(folder);
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  await host.jobs.upsertJob({ id: 'cancelled', status: 'scheduled', sendAt: Date.now() + 60000 });
  await host.jobs.upsertJob({ id: 'queued', status: 'sending' });
  await host.store.archiveActiveJob('queued', { status: 'queued' });
  await host.jobs.removeEditableJob('cancelled');
  assert.equal(host.jobs.getJobs().length, 0);
  assert.equal(host.jobs.getHistory().find((job) => job.id === 'cancelled').status, 'cancelled');
  await host.jobs.clearFinishedHistory();
  assert.deepEqual(host.jobs.getHistory().map((job) => job.id), ['queued']);
});

test('archiving a lost queue acknowledgement preserves uncertainty, retention, and exact progress tracking', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-uncertain-history-'));
  let sent = 0;
  let reads = 0;
  let turnStatus;
  const host = createJobHost(folder, { runtime: {
    queuePrompt: async () => {
      sent++;
      throw Object.assign(new Error('queue acknowledgement lost'), { submissionAttempted: true });
    },
    getTaskProgress: async (_runtime, job) => {
      reads++;
      return readTaskProgress(async () => ({ data: turnStatus ? [{ id: 'accepted-turn', status: turnStatus,
        startedAt: 10, completedAt: turnStatus === 'completed' ? 20 : null,
        items: [{ type: 'userMessage', clientId: job.clientMessageId }] }] : [] }), job);
    }
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'uncertain', status: 'scheduled', threadMode: 'existing', threadId: 'thread',
    prompt: 'Run once', sendAt: Date.now() };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.status === 'review');
  const before = host.jobs.getJobs()[0];
  assert.ok(before.clientMessageId);
  assert.equal(await host.jobs.removeEditableJob(job.id), true);
  let archived = host.jobs.getHistory()[0];
  assert.equal(archived.status, 'review');
  assert.equal(archived.finishedAt ?? null, null);
  assert.equal(archived.clientMessageId, before.clientMessageId);
  assert.equal(archived.submissionStartedAt, before.submissionStartedAt);
  assert.equal(archived.lastError, before.lastError);
  await until(() => reads > 0 && host.jobs.getHistory()[0]?.lastStatusCheckAt);
  assert.equal(host.jobs.getHistory()[0].status, 'review', 'missing evidence must not imply delivery or cancellation');
  await host.store.updateHistoryJob(job.id, { archivedAt: Date.now() - 40 * 86400000 });
  await host.jobs.clearFinishedHistory();
  await host.jobs.pruneHistory(1);
  assert.equal(host.jobs.getHistory()[0].status, 'review');
  await host.jobs.restoreTimers();
  assert.equal(sent, 1);
  turnStatus = 'inProgress';
  await host.jobs.refreshHistory();
  archived = host.jobs.getHistory()[0];
  assert.equal(archived.status, 'running');
  assert.equal(archived.turnId, 'accepted-turn');
  turnStatus = 'completed';
  await host.jobs.refreshHistory();
  archived = host.jobs.getHistory()[0];
  assert.equal(archived.status, 'completed');
  assert.equal(archived.terminalStatusConfirmed, true);
  assert.equal(archived.finishedAt, 20000);
  assert.equal(sent, 1);
  await host.jobs.clearFinishedHistory();
  assert.deepEqual(host.jobs.getHistory(), []);
});

test('manual refresh rechecks terminal rows, updates check times and repairs obsolete interrupted results', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-terminal-refresh-'));
  const observed = [];
  const host = createJobHost(folder, { runtime: { getTaskProgress: async (_runtime, job) => {
    observed.push(job.id);
    return { status: 'completed', terminalStatusConfirmed: true, finishedAt: 20000 };
  } } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  for (const status of ['interrupted', 'failed', 'completed', 'cancelled']) {
    await host.jobs.upsertJob({ id: status, threadId: 'thread', turnId: 'turn-' + status, archivedAt: Date.now(),
      status, terminalStatusConfirmed: true, lastStatusCheckAt: 10000 });
  }
  await host.jobs.refreshHistory();
  assert.deepEqual(observed.sort(), ['completed', 'failed', 'interrupted']);
  const repaired = host.jobs.getHistory().find((job) => job.id === 'interrupted');
  assert.equal(repaired.status, 'completed');
  assert.ok(repaired.lastStatusCheckAt > 10000);
  assert.equal(repaired.finishedAt, 20000);
  assert.equal(host.jobs.getHistory().find((job) => job.id === 'cancelled').lastStatusCheckAt, 10000);
});

test('a refresh requested during an ongoing check waits for the result instead of being dropped', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-refresh-in-flight-'));
  let enter;
  let release;
  let secondDone = false;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const host = createJobHost(folder, { runtime: { getTaskProgress: async () => {
    enter(); await gate; return { status: 'completed', terminalStatusConfirmed: true };
  } } });
  t.after(async () => { release(); host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  await host.jobs.upsertJob({ id: 'pending', threadId: 'thread', turnId: 'turn', status: 'running', archivedAt: Date.now() });
  const first = host.jobs.refreshHistory();
  await entered;
  const second = host.jobs.refreshHistory().then(() => { secondDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondDone, false);
  release();
  await Promise.all([first, second]);
  assert.equal(host.jobs.getHistory()[0].status, 'completed');
  assert.ok(host.jobs.getHistory()[0].lastStatusCheckAt);
});
