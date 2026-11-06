'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');
const { accountKey } = require('../src/accountIdentity');
const { DAY } = require('../src/availabilityPolicy');

const RUNTIME = { command: 'codex', baseArgs: [] };
const ACCOUNT = { account: { type: 'chatgpt', email: 'test@example.test', planType: 'plus' } };
const KEY = accountKey(ACCOUNT);
const fakeClient = { request: async () => ACCOUNT };
const ready = () => ({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } });

async function fixture(t, { read = async () => ({ accountKey: KEY, limits: ready() }), deliver, context,
  beforeAccount = ACCOUNT, targetModel = 'model', legacy = [], queue } = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-availability-'));
  let reads = 0;
  let sends = 0;
  const queued = [];
  const runtime = {
    resolveCodexRuntime: async () => RUNTIME,
    getAvailabilityContext: context || (async () => ({ accountKey: KEY, model: 'model' })),
    readAvailabilitySnapshot: async () => { reads++; return read(); },
    queuePrompt: async (_runtime, job) => {
      queued.push(job); sends++;
      return queue ? queue() : { id: 'queue-1' };
    }
  };
  const delivery = {
    deliverDirect: async (_runtime, job, onStarted, _onCreated, beforeSubmit) => {
      await beforeSubmit(beforeAccount === ACCOUNT ? fakeClient : { request: async () => beforeAccount }, { model: targetModel });
      sends++;
      if (deliver) return deliver(job, onStarted);
      await onStarted('turn-' + sends);
    }, dispose() {}
  };
  const host = createJobHost(folder, { runtime, delivery, legacy });
  t.after(async () => {
    for (const job of host.jobs.getJobs()) {
      const release = await host.locks.acquireFileLock('job:' + job.id, 1000);
      if (release) await release();
    }
    host.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  return { ...host, runtime, delivery, folder, queued, counts: () => ({ reads, sends }) };
}

function task(id = 'available') {
  return { id, threadMode: 'new', threadId: 'thread', model: 'model', sendMode: 'available', prompt: 'Continue',
    sendAt: Date.now(), nextCheckAt: Date.now(), expiresAt: Date.now() + 8 * DAY,
    waitDays: 8, status: 'scheduled', attempts: 0 };
}

test('a nearby base-quota reset shortens the cache even with a separate quota dictionary', async (t) => {
  for (const byId of [{}, { model: { primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 7200 } } }]) {
    const host = await fixture(t, { read: async () => ({ accountKey: KEY, limits: {
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 300 } },
      rateLimitsByLimitId: byId
    } }) });
    await host.availability.check(RUNTIME, task());
    const cache = JSON.parse(await fs.readFile(path.join(host.folder, 'availability.v1.json'), 'utf8'));
    assert.equal(cache.validUntil - cache.checkedAt, 2 * 60000);
    await host.availability.check(RUNTIME, task('shared'));
    assert.equal(host.counts().reads, 1, 'a fresh snapshot can still be shared');
  }
});

test('checking now cannot switch the account or replenish the send budget', async (t) => {
  for (const account of [KEY, 'account-B']) {
    const host = await fixture(t, { context: async () => ({ accountKey: account, model: 'model' }) });
    const job = { ...task('manual-' + account), accountKey: KEY, attempts: account === KEY ? 5 : 4, checkFailures: 3,
      nextCheckAt: Date.now() + 600000, lastError: 'prior error', waitReason: 'quota' };
    await host.jobs.upsertJob(job);
    const checked = await host.jobs.requestAvailabilityCheck(job.id);
    assert.deepEqual(checked, { ...job, nextCheckAt: checked.nextCheckAt, forceCheckAt: checked.forceCheckAt });
    host.jobs.scheduleTimer(checked);
    await until(() => host.jobs.getJobs()[0]?.status === 'paused');
    const paused = host.jobs.getJobs()[0];
    assert.equal(paused.accountKey, KEY);
    assert.equal(paused.attempts, job.attempts);
    assert.equal(paused.waitReason, account === KEY ? 'attempts' : 'accountChanged');
    assert.equal(host.counts().sends, 0);
  }
});

test('a newly saved task refreshes an older blocked cache and sends on its first check', async (t) => {
  let limits = { ordinaryUsageAllowed: false, rateLimits: { primary: {
    usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600
  } } };
  const host = await fixture(t, { read: async () => ({ accountKey: KEY, limits }) });
  const blocked = await host.availability.check(RUNTIME, task('older'));
  assert.equal(blocked.ready, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  limits = ready();
  const job = { ...task('fresh'), availabilityRequestedAt: Date.now() };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => !host.jobs.getJobs().length);
  assert.deepEqual(host.counts(), { reads: 2, sends: 1 });
  assert.equal(host.jobs.getHistory()[0].status, 'completed');
});

test('available tasks with conversation defaults use the owning Codex server queue', async (t) => {
  const host = await fixture(t, { deliver: async () => { throw new Error('must not open a separate writer'); } });
  const job = { ...task('open-thread'), threadMode: 'existing', model: null };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs().length === 0);
  assert.equal(host.queued[0].threadId, 'thread');
  assert.equal(host.queued[0].prompt, 'Continue');
  assert.deepEqual(host.counts(), { reads: 1, sends: 1 });
  // Acceptance invalidates the shared quota snapshot for the next task.
  await host.availability.check(RUNTIME, job);
  assert.equal(host.counts().reads, 2);
});

test('queue delivery rechecks the account before submitting', async (t) => {
  let checks = 0;
  const host = await fixture(t, { context: async () => ({ accountKey: ++checks === 1 ? KEY : 'changed', model: 'model' }) });
  const job = { ...task('changed-before-queue'), threadMode: 'existing', model: null };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'accountChanged');
  assert.equal(host.queued.length, 0);
});

test('a changed default model is checked again before queue submission', async (t) => {
  let checks = 0;
  const host = await fixture(t, { context: async () => ({ accountKey: KEY, model: ++checks === 1 ? 'model' : 'changed-model' }) });
  const job = { ...task('model-before-queue'), threadMode: 'existing', model: null };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'checking');
  assert.equal(host.queued.length, 0);
});

test('an uncertain queue result requires review and cannot be automatically queued twice', async (t) => {
  const host = await fixture(t, { queue: async () => { throw new Error('codex command timeout'); } });
  const job = { ...task('queue-unknown'), threadMode: 'existing', model: null };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.status === 'review');
  await host.jobs.restoreTimers();
  assert.equal(host.queued.length, 1);
});

test('limited jobs persist their waiting state, then send once after a fresh permission', async (t) => {
  let limits = { ordinaryUsageAllowed: false, rateLimits: {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 86400 }
  } };
  const host = await fixture(t, { read: async () => ({ accountKey: KEY, limits }) });
  const job = task();
  await host.jobs.upsertJob(job);
  host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'weekly');
  let waiting = host.jobs.getJobs()[0];
  assert.equal(waiting.attempts, 0);
  assert.equal(waiting.status, 'scheduled');
  assert.equal(waiting.sendAt, job.sendAt);
  assert.ok(waiting.nextCheckAt > Date.now());
  assert.deepEqual(host.counts(), { reads: 1, sends: 0 });
  const release = await host.locks.acquireFileLock('job:' + job.id, 1000);
  assert.ok(release); await release();
  limits = ready();
  waiting = { ...host.jobs.getJobs()[0], nextCheckAt: Date.now(), forceCheckAt: Date.now() };
  await host.jobs.upsertJob(waiting);
  host.jobs.scheduleTimer(waiting);
  await until(() => host.jobs.getJobs().length === 0);
  assert.deepEqual(host.counts(), { reads: 2, sends: 1 });
});

test('independent windows share one quota read for the same account', async (t) => {
  const host = await fixture(t);
  const other = createJobHost(host.folder, { runtime: host.runtime });
  t.after(() => other.jobs.dispose());
  const [a, b] = await Promise.all([
    host.availability.check(RUNTIME, task('a')), other.availability.check(RUNTIME, task('b'))
  ]);
  assert.equal(a.ready, true); assert.equal(b.ready, true);
  assert.equal(host.counts().reads, 1);
});

test('temporary outages keep the task with backoff; permanent authentication errors pause it', async (t) => {
  const host = await fixture(t, { read: async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); } });
  const job = task();
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'network');
  const waiting = host.jobs.getJobs()[0];
  assert.equal(waiting.status, 'scheduled');
  assert.equal(waiting.attempts, 0);
  assert.ok(waiting.nextCheckAt > Date.now());
  assert.equal(host.counts().sends, 0);

  const auth = await fixture(t, { context: async () => { throw Object.assign(new Error('login required'), { code: 'AUTH_REQUIRED' }); } });
  await auth.jobs.upsertJob(task('auth')); auth.jobs.scheduleTimer(task('auth'));
  await until(() => auth.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(auth.jobs.getJobs()[0].waitReason, 'auth');
});

test('expired jobs and exhausted send attempts cannot submit a prompt', async (t) => {
  const host = await fixture(t);
  const expired = { ...task('expired'), expiresAt: Date.now() - 1 };
  await host.jobs.upsertJob(expired); host.jobs.scheduleTimer(expired);
  await until(() => host.jobs.getJobs().find((job) => job.id === 'expired')?.status === 'expired');
  const exhausted = { ...task('exhausted'), attempts: 5 };
  await host.jobs.upsertJob(exhausted); host.jobs.scheduleTimer(exhausted);
  await until(() => host.jobs.getJobs().find((job) => job.id === 'exhausted')?.status === 'paused');
  assert.equal(host.counts().sends, 0);
});

test('unknown submission results require review, including after a restart', async (t) => {
  const host = await fixture(t, { deliver: async () => { throw new Error('connection lost after writing prompt'); } });
  await host.jobs.upsertJob(task()); host.jobs.scheduleTimer(task());
  await until(() => host.jobs.getJobs()[0]?.status === 'review');
  assert.equal(host.counts().sends, 1);
  assert.ok(host.jobs.getJobs()[0].submissionStartedAt);
  const recovering = await fixture(t, { legacy: [{ ...task('recovery'), status: 'sending', submissionStartedAt: Date.now() }] });
  await recovering.jobs.restoreTimers();
  assert.equal(recovering.jobs.getJobs()[0].status, 'review');
  assert.equal(recovering.counts().sends, 0);
});

test('temporary errors continue after ten failed checks and do not consume send attempts', async (t) => {
  const host = await fixture(t, { context: async () => { throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' }); } });
  const job = { ...task(), checkFailures: 10 };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.checkFailures === 11);
  const waiting = host.jobs.getJobs()[0];
  assert.equal(waiting.status, 'scheduled');
  assert.equal(waiting.attempts, 0);
  assert.ok(waiting.nextCheckAt > Date.now() + 14 * 60000);
});

test('account switches are detected again immediately before submission', async (t) => {
  const host = await fixture(t, { beforeAccount: { account: { ...ACCOUNT.account, email: 'other@example.test' } } });
  await host.jobs.upsertJob(task()); host.jobs.scheduleTimer(task());
  await until(() => host.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'accountChanged');
  assert.equal(host.jobs.getJobs()[0].submissionStartedAt, null);
  assert.equal(host.counts().sends, 0);
});

test('five explicit rejections exhaust the send budget; quota checks do not', async (t) => {
  const host = await fixture(t, { deliver: async () => {
    throw Object.assign(new Error('429 rate limit'), { submissionRejected: true });
  } });
  const original = task();
  await host.jobs.upsertJob(original); host.jobs.scheduleTimer(original);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await until(() => {
      const job = host.jobs.getJobs()[0];
      return job?.attempts === attempt && ['scheduled', 'paused'].includes(job.status);
    });
    const release = await host.locks.acquireFileLock('job:' + original.id, 1000);
    assert.ok(release); await release();
    if (attempt < 5) {
      await host.availability.invalidate(KEY);
      const due = { ...host.jobs.getJobs()[0], nextCheckAt: Date.now() };
      await host.jobs.upsertJob(due); host.jobs.scheduleTimer(due);
    }
  }
  assert.equal(host.jobs.getJobs()[0].status, 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'attempts');
  assert.equal(host.counts().sends, 5);
});

test('a crash during a read-only availability check is recoverable without resending', async (t) => {
  const blocked = { ordinaryUsageAllowed: false, rateLimits: { secondary: {
    usedPercent: 100, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 86400
  } } };
  const host = await fixture(t, { read: async () => ({ accountKey: KEY, limits: blocked }),
    legacy: [{ ...task('checking'), status: 'checking' }] });
  await host.jobs.restoreTimers();
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'weekly');
  assert.equal(host.jobs.getJobs()[0].status, 'scheduled');
  assert.equal(host.counts().sends, 0);
});

test('two windows never submit the same ready task twice', async (t) => {
  let finish;
  let other;
  const done = new Promise((resolve) => { finish = resolve; });
  t.after(() => { finish(); other?.jobs.dispose(); });
  const host = await fixture(t, { deliver: async (_job, onStarted) => { await onStarted('turn-1'); await done; } });
  // Either watcher may win the claim. Both must be able to deliver, and both
  // contribute to the same counter so the assertion detects a real duplicate.
  other = createJobHost(host.folder, { runtime: host.runtime, delivery: host.delivery });
  const job = task();
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.turnId === 'turn-1');
  await Promise.all([host.jobs.restoreTimers(), other.jobs.restoreTimers()]);
  assert.equal(host.counts().sends, 1);
  finish();
  await until(() => host.jobs.getJobs().length === 0);
  assert.equal(host.counts().sends, 1);
});

test('unknown quota permission waits without sending a probe prompt', async (t) => {
  const host = await fixture(t, { read: async () => ({ accountKey: KEY, limits: { ...ready(), ordinaryUsageAllowed: null } }) });
  await host.jobs.upsertJob(task()); host.jobs.scheduleTimer(task());
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'unknown');
  assert.equal(host.jobs.getJobs()[0].status, 'scheduled');
  assert.equal(host.counts().sends, 0);
});

test('a changed conversation model triggers another check before any prompt is sent', async (t) => {
  const host = await fixture(t, { targetModel: 'different-model' });
  await host.jobs.upsertJob(task()); host.jobs.scheduleTimer(task());
  await until(() => host.jobs.getJobs()[0]?.waitReason === 'checking');
  assert.equal(host.jobs.getJobs()[0].status, 'scheduled');
  assert.equal(host.jobs.getJobs()[0].attempts, 0);
  assert.equal(host.counts().sends, 0);
});
