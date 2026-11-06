'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost, until } = require('./helpers/jobHost');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const task = (id, sendAt) => ({
  id, sendAt, status: 'scheduled', threadMode: 'existing',
  threadId: '12345678-1234-4234-8234-123456789abc', prompt: id, attempts: 0
});

for (const scenario of ['handoff', 'earlier', 'later', 'removed', 'both-active']) {
  test(`shared timers: ${scenario}`, async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-windows-'));
    const sends = [];
    let observed = [];
    let ready = false;
    const runtime = { queuePrompt: async () => { sends.push(Date.now()); await delay(10); return { id: 'queue-1' }; } };
    const a = createJobHost(folder, { runtime });
    const b = createJobHost(folder, { runtime, onChange: () => { observed = b.jobs.getJobs(); ready = true; } });
    t.after(async () => {
      a.jobs.dispose(); b.jobs.dispose();
      await fs.rm(folder, { recursive: true, force: true });
    });
    await until(() => ready);
    const original = task(scenario, Date.now() + (scenario === 'earlier' ? 1000 : 300));
    await a.jobs.upsertJob(original);
    a.jobs.scheduleTimer(original);
    await until(() => observed.some((job) => job.id === original.id));
    let due = original.sendAt;
    if (scenario === 'earlier' || scenario === 'later') {
      due = Date.now() + (scenario === 'earlier' ? 200 : 600);
      const edited = await a.jobs.updateEditableJob(original.id, { sendAt: due });
      a.jobs.scheduleTimer(edited);
      await until(() => observed.some((job) => job.sendAt === due));
    }
    if (scenario === 'removed') {
      await a.jobs.removeEditableJob(original.id);
      await until(() => observed.length === 0);
    }
    if (scenario !== 'both-active') a.jobs.dispose();
    if (scenario === 'removed') {
      await delay(Math.max(0, original.sendAt - Date.now()) + 50);
      assert.equal(sends.length, 0);
    } else {
      await until(() => sends.length > 0 && b.jobs.getJobs().length === 0);
      assert.equal(sends.length, 1);
      assert.ok(sends[0] >= due, 'Task was sent before its updated due time');
    }
  });
}

test('a timer waiting for storage rechecks a postponed task and survives the editor closing', { timeout: 10000 }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-postpone-'));
  let block = false;
  let entered;
  let proceed;
  let released;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { proceed = resolve; });
  const finished = new Promise((resolve) => { released = resolve; });
  const sends = [];
  const io = {
    ...fs,
    open: async (...args) => {
      if (block && args[0] === a.locks.getLockPath('jobs') && args[1] === 'wx') {
        block = false;
        entered();
        await gate;
      }
      return fs.open(...args);
    },
    unlink: async (...args) => {
      await fs.unlink(...args);
      if (args[0] === a.locks.getLockPath('job:postponed')) released();
    }
  };
  const runtime = { queuePrompt: async () => { sends.push(Date.now()); return { id: 'queue-1' }; } };
  const a = createJobHost(folder, { io, runtime });
  const editorIo = {
    ...fs,
    open: async (...args) => {
      // Let A reach the storage lock before B's timer competes for the job lock.
      if (args[0] === a.locks.getLockPath('job:postponed') && args[1] === 'wx') await waiting;
      return fs.open(...args);
    }
  };
  const b = createJobHost(folder, { runtime, io: editorIo });
  t.after(async () => {
    proceed();
    a.jobs.dispose(); b.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const original = task('postponed', Date.now() + 200);
  await a.jobs.upsertJob(original);
  a.jobs.scheduleTimer(original);
  block = true;
  await waiting;
  const due = Date.now() + 500;
  const edited = await b.jobs.updateEditableJob(original.id, { sendAt: due });
  assert.equal(edited.sendAt, due);
  b.jobs.scheduleTimer(edited);
  await delay(30);
  b.jobs.dispose();
  proceed();
  await finished;
  assert.equal(sends.length, 0);
  assert.equal(a.jobs.getJobs()[0].status, 'scheduled');
  await until(() => sends.length > 0 && a.jobs.getJobs().length === 0);
  assert.equal(sends.length, 1);
  assert.ok(sends[0] >= due);
});

test('editing a paused task while its previous sender releases the lock cannot lose its timer', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-edit-cleanup-'));
  let target;
  let held = false;
  let proceed;
  let released;
  const gate = new Promise((resolve) => { proceed = resolve; });
  const cleanupDone = new Promise((resolve) => { released = resolve; });
  let sends = 0;
  const host = createJobHost(folder, { runtime: { queuePrompt: async () => { sends++; return { id: 'queue-1' }; } },
    io: { ...fs, unlink: async (...args) => {
      if (args[0] === target && !held) {
        held = true;
        await gate;
        await fs.unlink(...args);
        released();
        return;
      }
      return fs.unlink(...args);
    } } });
  t.after(async () => {
    host.jobs.dispose(); proceed();
    if (held) await cleanupDone;
    await fs.rm(folder, { recursive: true, force: true });
  });
  target = host.locks.getLockPath('job:edited-during-cleanup');
  const job = { ...task('edited-during-cleanup', Date.now()), model: 'legacy-model' };
  await host.jobs.upsertJob(job); host.jobs.scheduleTimer(job);
  await host.waitFor(() => held && host.jobs.getJobs()[0]?.status === 'paused');
  const edited = await host.jobs.updateEditableJob(job.id, { model: null, sendAt: Date.now() });
  host.jobs.scheduleTimer(edited);
  await delay(30);
  assert.equal(sends, 0, 'the old sender must finish cleanup before the edited job runs');
  proceed();
  await host.waitFor(() => host.jobs.getHistory().some((item) => item.id === job.id && item.status === 'queued'));
  assert.equal(sends, 1);
});

test('startup recovery reports an exhausted lock-release failure without submitting a prompt', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-recovery-release-'));
  let lockPath;
  let attempts = 0;
  let sends = 0;
  const host = createJobHost(folder, {
    legacy: [{ ...task('interrupted-recovery', Date.now()), status: 'checking', sendMode: 'available',
      expiresAt: Date.now() + 86400000 }],
    runtime: { queuePrompt: async () => { sends++; return { id: 'unexpected' }; } },
    io: { ...fs, unlink: async (...args) => {
      if (args[0] === lockPath) {
        attempts++;
        throw Object.assign(new Error('EACCES: cannot delete recovery lock'), { code: 'EACCES' });
      }
      return fs.unlink(...args);
    } }
  });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  lockPath = host.locks.getLockPath('job:interrupted-recovery');
  await host.jobs.restoreTimers();
  assert.ok(attempts > 1 && attempts <= 7, 'release retries must be exhausted before reporting');
  assert.equal(host.notifications.filter((message) => message.includes('EACCES: cannot delete recovery lock')).length, 1);
  assert.equal(host.jobs.getJobs()[0].status, 'scheduled');
  assert.equal(sends, 0);
  assert.ok(await fs.stat(lockPath), 'a failed deletion must not pretend ownership was released');
});
