'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJobHost, until } = require('./helpers/jobHost');
const { accountKey } = require('../src/accountIdentity');

const threadId = '12345678-1234-4123-8123-123456789abc';

test('available new-thread tasks start immediately and retain the created thread and completed result', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-immediate-new-'));
  let finish;
  let calls = 0;
  let started = false;
  const completion = new Promise((resolve) => { finish = resolve; });
  const account = { account: { type: 'chatgpt', email: 'test@example.test' } };
  const key = accountKey(account);
  const runtime = {
    getAvailabilityContext: async () => ({ accountKey: key, model: 'default-model' }),
    readAvailabilitySnapshot: async () => ({ accountKey: key, limits: { ordinaryUsageAllowed: true } }),
    queuePrompt: async () => { throw new Error('a new thread must not use an existing conversation queue'); }
  };
  const host = createJobHost(folder, { runtime, delivery: {
    deliverDirect: async (_runtime, job, onStarted, onCreated, beforeSubmit) => {
      calls++;
      assert.equal(job.threadId, null);
      await onCreated(threadId);
      await beforeSubmit({ request: async () => account }, { model: 'default-model' });
      await onStarted('new-turn'); started = true;
      await completion;
    }, dispose() { finish(); }
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'new-now', threadMode: 'new', threadId: null, prompt: 'Run now', status: 'scheduled',
    sendMode: 'available', sendAt: Date.now() + 600000, nextCheckAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => started);
  assert.equal(host.jobs.getJobs()[0].threadId, threadId);
  assert.equal(host.jobs.getJobs()[0].status, 'sending');
  assert.equal(host.jobs.getJobs()[0].turnId, 'new-turn');
  finish();
  await until(() => !host.jobs.getJobs().length);
  assert.equal(host.jobs.getHistory()[0].threadId, threadId);
  assert.equal(host.jobs.getHistory()[0].status, 'completed');
  assert.ok(host.jobs.getHistory()[0].finishedAt >= host.jobs.getHistory()[0].acceptedAt);
  host.jobs.dispose();
  const restored = createJobHost(folder, { runtime });
  t.after(() => restored.jobs.dispose());
  await restored.jobs.restoreTimers();
  assert.equal(restored.jobs.getHistory()[0].status, 'completed');
  assert.equal(calls, 1);
});

test('new threads with default settings use direct delivery and retain their ID on manual retry', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-new-default-'));
  let created = 0;
  let sent = 0;
  let queued = 0;
  const host = createJobHost(folder, {
    runtime: { queuePrompt: async () => { queued++; throw new Error('queue cannot find an unpersisted rollout'); } },
    delivery: {
      deliverDirect: async (_runtime, job, onStarted, onThreadCreated) => {
        sent++;
        assert.equal(job.model, undefined);
        assert.equal(job.cwd, '/original-workspace');
        if (!job.threadId) {
          created++;
          await onThreadCreated(threadId);
          assert.equal(host.jobs.getJobs()[0].threadId, threadId);
        } else assert.equal(job.threadId, threadId);
        await onStarted('turn-' + sent);
        if (sent === 1) throw new Error('rate limit after acceptance');
      },
      dispose() {}
    }
  });
  try {
    const job = { id: 'new-thread', threadMode: 'new', threadId: null, cwd: '/original-workspace',
      prompt: 'Run this', sendAt: Date.now() + 30, status: 'scheduled', attempts: 0 };
    await host.jobs.upsertJob(job);
    assert.equal(created, 0);
    host.jobs.scheduleTimer(job);
    await until(() => host.jobs.getJobs()[0]?.status === 'review');
    assert.equal(created, 1);
    assert.equal(host.jobs.getJobs()[0].threadInitialized, true);
    const retried = await host.jobs.updateEditableJob(job.id, { sendAt: Date.now() + 30 });
    host.jobs.scheduleTimer(retried);
    await until(() => host.jobs.getJobs().length === 0);
    assert.equal(created, 1);
    assert.equal(sent, 2);
    assert.equal(queued, 0);
  } finally { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('existing conversations with default settings still use the Codex queue', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-existing-default-'));
  const queued = [];
  const host = createJobHost(folder, {
    runtime: { queuePrompt: async (_runtime, job) => { queued.push(job); return { id: 'queue-1' }; } },
    delivery: { deliverDirect: async () => { throw new Error('unexpected direct delivery'); }, dispose() {} }
  });
  try {
    const job = { id: 'existing-thread', threadMode: 'existing', threadId, prompt: 'Continue',
      sendAt: Date.now() + 30, status: 'scheduled', attempts: 0 };
    await host.jobs.upsertJob(job);
    host.jobs.scheduleTimer(job);
    await until(() => host.jobs.getJobs().length === 0);
    assert.equal(queued[0].threadId, threadId);
    assert.equal(queued[0].prompt, 'Continue');
  } finally { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
