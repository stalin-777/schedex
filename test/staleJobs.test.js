'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');
const { accountKey } = require('../src/accountIdentity');
const KEY = accountKey({ account: { type: 'chatgpt', email: 'test@example.test' } });

async function fixture(t, { policy = 'skip', revision = 'after', sendMode = 'time' } = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-stale-'));
  const state = { revision, sent: 0, reads: 0 };
  const runtime = {
    getThreadRevision: async () => { state.reads++; if (state.revision instanceof Error) throw state.revision; return state.revision; },
    queuePrompt: async () => { state.sent++; return { id: 'queue-1' }; },
    getAvailabilityContext: async () => ({ accountKey: KEY, model: 'model' }),
    readAvailabilitySnapshot: async () => ({ accountKey: KEY, limits: { ordinaryUsageAllowed: true } })
  };
  const host = createJobHost(folder, { runtime });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'stale', threadMode: 'existing', threadId: 'thread', prompt: 'Continue', stalePolicy: policy,
    threadRevision: 'before', sendAt: Date.now(), nextCheckAt: Date.now(), sendMode,
    expiresAt: Date.now() + 86400000, status: 'scheduled', attempts: 0 };
  await host.jobs.upsertJob(job);
  host.jobs.scheduleTimer(job);
  return { ...host, folder, state, runtime };
}

test('changed conversations skip protected prompts in both scheduling modes', async (t) => {
  for (const sendMode of ['time', 'available']) {
    const host = await fixture(t, { sendMode });
    await until(() => host.jobs.getJobs()[0]?.status === 'skipped');
    assert.equal(host.state.sent, 0);
    assert.equal(host.jobs.getJobs()[0].attempts, 0);
    await host.jobs.restoreTimers();
    assert.equal(host.jobs.getJobs()[0].status, 'skipped');
  }
});

test('unchanged history sends once; Send anyway does not require a history read', async (t) => {
  const unchanged = await fixture(t, { revision: 'before' });
  await until(() => !unchanged.jobs.getJobs().length);
  assert.equal(unchanged.state.sent, 1);
  const unprotected = await fixture(t, { policy: 'send', revision: new Error('not available') });
  await until(() => !unprotected.jobs.getJobs().length);
  assert.equal(unprotected.state.sent, 1);
  assert.equal(unprotected.state.reads, 0);
});

test('unreadable history pauses a protected prompt without spending a send attempt', async (t) => {
  const host = await fixture(t, { revision: new Error('offline') });
  await until(() => host.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'history');
  assert.equal(host.jobs.getJobs()[0].attempts, 0);
  assert.equal(host.state.sent, 0);
});

test('confirmation survives restart and concurrent window decisions submit only once', async (t) => {
  const host = await fixture(t, { policy: 'confirm' });
  await until(() => host.jobs.getJobs()[0]?.status === 'confirmation');
  const pending = host.jobs.getJobs()[0];
  host.jobs.dispose();
  const a = createJobHost(host.folder, { runtime: host.runtime });
  const b = createJobHost(host.folder, { runtime: host.runtime });
  t.after(() => { a.jobs.dispose(); b.jobs.dispose(); });
  await a.jobs.restoreTimers(); await b.jobs.restoreTimers();
  assert.equal(host.state.sent, 0);
  await Promise.all([a.jobs.resolveStaleJob(pending.id, pending.confirmationId, 'send'),
    b.jobs.resolveStaleJob(pending.id, pending.confirmationId, 'send')]);
  await until(() => !a.jobs.getJobs().length);
  assert.equal(host.state.sent, 1);
});

test('further messages require fresh confirmation and obsolete replies cannot authorize sending', async (t) => {
  const host = await fixture(t, { policy: 'confirm' });
  await until(() => host.jobs.getJobs()[0]?.status === 'confirmation');
  const first = host.jobs.getJobs()[0];
  host.state.revision = 'even-newer';
  await host.jobs.resolveStaleJob(first.id, first.confirmationId, 'send');
  await until(() => host.jobs.getJobs()[0]?.status === 'confirmation');
  const second = host.jobs.getJobs()[0];
  assert.notEqual(first.confirmationId, second.confirmationId);
  assert.equal(host.state.sent, 0);
  await host.jobs.resolveStaleJob(first.id, first.confirmationId, 'send');
  assert.equal(host.jobs.getJobs()[0].status, 'confirmation');
  await host.jobs.resolveStaleJob(second.id, second.confirmationId, 'skip');
  assert.equal(host.jobs.getJobs()[0].status, 'skipped');
  assert.equal(host.state.sent, 0);
});

test('confirmation cannot extend an expired availability deadline', async (t) => {
  const host = await fixture(t, { policy: 'confirm', sendMode: 'available' });
  await until(() => host.jobs.getJobs()[0]?.status === 'confirmation');
  const pending = host.jobs.getJobs()[0];
  await host.store.updateJobs((jobs) => { jobs[0].expiresAt = Date.now() - 1; });
  await host.jobs.resolveStaleJob(pending.id, pending.confirmationId, 'send');
  assert.equal(host.jobs.getJobs()[0].status, 'expired');
  assert.equal(host.state.sent, 0);
});
