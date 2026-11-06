'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');
const { accountKey } = require('../src/accountIdentity');

const account = (email) => ({ account: { type: 'chatgpt', email } });
const A = account('work@example.test');
const B = account('personal@example.test');

for (const sendMode of ['time', 'available']) {
  test(`${sendMode} jobs pause on account changes and never adopt an unbound legacy task`, async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-account-'));
    let sends = 0;
    const host = createJobHost(folder, { bindAccount: false, runtime: {
      getAccountKey: async () => accountKey(B),
      getAvailabilityContext: async () => ({ accountKey: accountKey(B), model: 'model' }),
      queuePrompt: async () => { sends++; return { id: 'queue' }; }
    } });
    t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
    for (const bound of [true, false]) {
      const job = { id: bound ? 'changed' : 'legacy', sendMode, threadMode: 'existing', threadId: 'thread',
        prompt: 'Sensitive work', status: 'scheduled', sendAt: Date.now(), nextCheckAt: Date.now(),
        expiresAt: Date.now() + 86400000, attempts: 2, ...(bound ? { accountKey: accountKey(A) } : {}) };
      await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
      await until(() => host.jobs.getJobs().find((item) => item.id === job.id)?.status === 'paused');
      const paused = host.jobs.getJobs().find((item) => item.id === job.id);
      assert.equal(paused.waitReason, bound ? 'accountChanged' : 'accountMissing');
      assert.equal(paused.accountKey, bound ? accountKey(A) : undefined);
      assert.equal(paused.attempts, 2);
    }
    assert.equal(sends, 0);
  });
}

test('fixed-time queue delivery checks the account after the protected history read', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-late-account-'));
  let current = A;
  let sends = 0;
  const host = createJobHost(folder, { runtime: {
    getAccountKey: async () => accountKey(current),
    readAccount: async () => current,
    getThreadRevision: async () => { current = B; return 'baseline'; },
    queuePrompt: async () => { sends++; return { id: 'queue' }; }
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'late-switch', accountKey: accountKey(A), threadMode: 'existing', threadId: 'thread',
    prompt: 'Private', status: 'scheduled', sendAt: Date.now(), stalePolicy: 'skip', threadRevision: 'baseline' };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'accountChanged');
  assert.equal(sends, 0);
});

test('fixed-time direct delivery verifies the account again before its first turn', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-direct-account-'));
  let sends = 0;
  const host = createJobHost(folder, { runtime: { getAccountKey: async () => accountKey(A) }, delivery: {
    deliverDirect: async (_runtime, _job, _started, _created, beforeSubmit) => {
      await beforeSubmit({ request: async () => B }); sends++;
    }, dispose() {}
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const job = { id: 'new', accountKey: accountKey(A), threadMode: 'new', prompt: 'Private', status: 'scheduled', sendAt: Date.now() };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await until(() => host.jobs.getJobs()[0]?.status === 'paused');
  assert.equal(host.jobs.getJobs()[0].waitReason, 'accountChanged');
  assert.equal(sends, 0);
});
