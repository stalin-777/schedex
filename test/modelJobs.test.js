'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');

test('legacy existing-thread overrides pause before touching Codex and can be edited to use its queue', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-legacy-settings-'));
  let opened = 0;
  let queued = 0;
  const host = createJobHost(folder, { runtime: {
    resolveCodexRuntime: async () => { opened++; return {}; },
    queuePrompt: async () => { queued++; return { id: 'queue-1' }; }
  }, delivery: { deliverDirect: async () => { throw new Error('must not submit legacy model overrides'); }, dispose() {} } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  for (const sendMode of ['time', 'available']) {
    const job = { id: 'legacy-' + sendMode, threadId: 'thread', threadMode: 'existing', sendMode,
      model: 'large', reasoningEffort: 'xhigh', prompt: 'Continue', status: 'scheduled', attempts: 0,
      sendAt: Date.now(), nextCheckAt: Date.now(), expiresAt: Date.now() + 86400000 };
    await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
    await host.waitFor(() => host.jobs.getJobs().find((item) => item.id === job.id)?.status === 'paused', undefined,
      () => ({ expectedJob: job.id, opened, queued }));
    const paused = host.jobs.getJobs().find((item) => item.id === job.id);
    assert.equal(paused.waitReason, 'threadSettings');
    assert.equal(paused.model, 'large');
    assert.equal(paused.attempts, 0);
  }
  assert.equal(opened, 0);
  const edited = await host.jobs.updateEditableJob('legacy-time', { model: null, reasoningEffort: null, sendAt: Date.now() });
  host.jobs.scheduleTimer(edited);
  await host.waitFor(() => host.jobs.getHistory().some((job) => job.id === edited.id && job.status === 'queued'), undefined,
    () => ({ expectedJob: edited.id, opened, queued }));
  assert.equal(queued, 1);
});

test('queue delivery waits for a direct task in the same conversation across windows', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-thread-owner-'));
  let finish;
  let running = false;
  let queued = 0;
  const completion = new Promise((resolve) => { finish = resolve; });
  const runtime = { queuePrompt: async () => { queued++; return { id: 'queue-1' }; } };
  const a = createJobHost(folder, { runtime, delivery: {
    deliverDirect: async () => { running = true; await completion; }, dispose() {}
  } });
  let b;
  t.after(async () => {
    finish(); a.jobs.dispose(); b?.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const direct = { id: 'direct-owner', threadMode: 'new', threadId: 'thread', model: 'large', sendAt: Date.now(), status: 'scheduled' };
  await a.jobs.upsertJob(direct);
  a.jobs.scheduleTimer(direct);
  await until(() => running);
  b = createJobHost(folder, { runtime });
  const followup = { id: 'queued-followup', threadId: 'thread', sendAt: Date.now(), status: 'scheduled', attempts: 0 };
  await b.jobs.upsertJob(followup);
  b.jobs.scheduleTimer(followup);
  await until(() => b.jobs.getJobs().find((job) => job.id === followup.id)?.nextAttemptAt > Date.now());
  const deferred = b.jobs.getJobs().find((job) => job.id === followup.id);
  assert.equal(queued, 0);
  assert.equal(deferred.status, 'scheduled');
  assert.equal(deferred.attempts, 0);
  assert.ok(deferred.nextAttemptAt > Date.now());
  finish();
  await until(() => !b.jobs.getJobs().some((job) => job.id === direct.id));
  const retried = await b.jobs.updateEditableJob(followup.id, { sendAt: Date.now() });
  b.jobs.scheduleTimer(retried);
  await until(() => !b.jobs.getJobs().length);
  assert.equal(queued, 1);
});

test('busy custom-model tasks retain settings and are rescheduled without consuming retries', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-model-busy-'));
  const host = createJobHost(folder, { delivery: {
    deliverDirect: async () => { throw Object.assign(new Error('busy'), { code: 'THREAD_BUSY' }); },
    dispose() {}
  } });
  try {
    const job = { id: 'custom-busy', threadMode: 'new', model: 'large', reasoningEffort: 'xhigh', threadId: 'thread',
      sendAt: Date.now(), status: 'scheduled', attempts: 0 };
    await host.jobs.upsertJob(job);
    host.jobs.scheduleTimer(job);
    await until(() => host.jobs.getJobs()[0]?.lastError === 'busy');
    const actual = host.jobs.getJobs()[0];
    assert.equal(actual.status, 'scheduled');
    assert.equal(actual.attempts, 0);
    assert.equal(actual.model, 'large');
    assert.equal(actual.reasoningEffort, 'xhigh');
    assert.equal(actual.sendAt, job.sendAt);
    assert.ok(actual.nextAttemptAt > Date.now());
    // Wait for the sender to finish installing its retry timer before disposing it.
    const release = await host.locks.acquireFileLock('job:custom-busy', 1000);
    assert.ok(release);
    await release();
  } finally { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('accepted custom turns persist their ID and never auto-retry a subsequent rate-limit error', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-model-accepted-'));
  let calls = 0;
  const host = createJobHost(folder, { delivery: {
    deliverDirect: async (_runtime, job, onStarted) => {
      calls++;
      assert.equal(job.reasoningEffort, 'xhigh');
      await onStarted('turn-1');
      assert.equal(host.jobs.getJobs()[0].turnId, 'turn-1');
      throw new Error('rate limit after starting');
    },
    dispose() {}
  } });
  try {
    const job = { id: 'custom-accepted', threadMode: 'new', model: 'large', reasoningEffort: 'xhigh', threadId: 'thread',
      sendAt: Date.now(), status: 'scheduled', attempts: 0 };
    await host.jobs.upsertJob(job);
    host.jobs.scheduleTimer(job);
    await until(() => host.jobs.getJobs()[0]?.status === 'review');
    assert.equal(calls, 1);
    assert.equal(host.jobs.getJobs()[0].turnId, 'turn-1');
    const retried = await host.jobs.updateEditableJob(job.id, { sendAt: Date.now() + 60000 });
    assert.equal(retried.turnId, null);
    assert.equal(retried.model, 'large');
  } finally { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
