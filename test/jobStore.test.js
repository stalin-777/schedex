'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobHost } = require('./helpers/jobHost');

test('independent windows preserve shared writes without refreshing their Memento caches', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-store-'));
  const hosts = [createJobHost(folder), createJobHost(folder)];
  t.after(async () => {
    hosts.forEach((host) => host.jobs.dispose());
    await fs.rm(folder, { recursive: true, force: true });
  });
  const due = Date.now() + 60000;
  await Promise.all(Array.from({ length: 12 }, (_, id) => hosts[id % 2].jobs.upsertJob({ id: String(id), status: 'scheduled', sendAt: due })));
  assert.equal(hosts[0].jobs.getJobs().length, 12);
  await Promise.all([
    hosts[0].jobs.removeEditableJob('0'),
    hosts[1].jobs.updateEditableJob('1', { prompt: 'Edited' })
  ]);
  const jobs = hosts[0].jobs.getJobs();
  assert.equal(jobs.length, 11);
  assert.equal(jobs.some((job) => job.id === '0'), false);
  assert.equal(jobs.find((job) => job.id === '1').prompt, 'Edited');
  assert.deepEqual(hosts[1].jobs.getJobs(), jobs);
});

test('legacy tasks migrate once and a corrupt file is never overwritten with cached state', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-migration-'));
  const legacy = [{ id: 'old', status: 'failed' }];
  const host = createJobHost(folder, { legacy });
  t.after(async () => {
    host.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  await host.jobs.upsertJob({ id: 'new', status: 'failed' });
  await host.jobs.removeEditableJob('old');
  await host.jobs.upsertJob({ id: 'third', status: 'failed' });
  assert.deepEqual(host.jobs.getJobs().map((job) => job.id), ['new', 'third']);
  // Stop observation before intentionally corrupting the file.
  host.jobs.dispose();
  const filePath = host.store.getJobsFilePath();
  await fs.writeFile(filePath, '{broken');
  await assert.rejects(host.jobs.upsertJob({ id: 'lost', status: 'failed' }), SyntaxError);
  assert.equal(await fs.readFile(filePath, 'utf8'), '{broken');
});

test('retrying an old new-thread rollout failure preserves proof that its ID was provisional', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-rollout-retry-'));
  const legacy = [
    { id: 'empty', threadMode: 'new', threadId: 'unpersisted', status: 'failed',
      lastError: 'thread/queue/add failed: no rollout found for thread id unpersisted' },
    { id: 'accepted', threadMode: 'new', threadId: 'accepted', status: 'failed', threadInitialized: true,
      turnId: 'turn-1', lastError: 'no rollout found for thread id accepted' },
    { id: 'existing', threadMode: 'existing', threadId: 'existing', status: 'failed', lastError: 'no rollout found' }
  ];
  const host = createJobHost(folder, { legacy });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const retried = await host.jobs.updateEditableJob('empty', { sendAt: Date.now() + 60000 });
  assert.equal(retried.threadInitialized, false);
  assert.equal(retried.lastError, null);
  const changes = { sendAt: Date.now() + 60000 };
  assert.equal((await host.jobs.updateEditableJob('accepted', changes)).threadInitialized, true);
  assert.equal((await host.jobs.updateEditableJob('existing', changes)).threadInitialized, undefined);
});

test('a history batch writes once, preserves concurrent changes and never recreates removed rows', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-history-batch-'));
  let writes = 0;
  const a = createJobHost(folder, { io: { ...fs, rename: async (...args) => { writes++; return fs.rename(...args); } } });
  const b = createJobHost(folder);
  t.after(async () => { a.jobs.dispose(); b.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  for (const id of ['one', 'two', 'removed']) await a.jobs.upsertJob({ id, archivedAt: Date.now(), status: 'queued' });
  await b.jobs.removeJob('removed');
  await b.jobs.upsertJob({ id: 'concurrent', status: 'paused', prompt: 'Keep me' });
  writes = 0;
  await a.store.updateHistoryJobs(['one', 'two', 'removed'].map((id) => ({ id, changes: { status: 'completed', terminalStatusConfirmed: true } })));
  assert.equal(writes, 1);
  assert.equal(a.jobs.getHistory().length, 2);
  assert.equal(a.jobs.getJobs()[0].prompt, 'Keep me');
  assert.equal(a.jobs.getHistory().every((job) => job.status === 'completed'), true);
});

test('history pages are bounded and retention preserves active, running and unconfirmed work', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-retention-'));
  const host = createJobHost(folder);
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  const old = Date.now() - 40 * 86400000;
  await host.store.updateJobs((rows) => {
    rows.push(...Array.from({ length: 60 }, (_, i) => ({ id: 'done-' + i, archivedAt: old + i, status: 'completed' })));
    for (const status of ['queued', 'running', 'delivered', 'interrupted']) rows.push({ id: status, status, archivedAt: old });
    rows.push({ id: 'pending', status: 'scheduled', sendAt: Date.now() + 600000 });
  });
  const page = host.store.getSnapshot(1);
  assert.equal(page.history.length, 25);
  assert.equal(page.historyTotal, 64);
  assert.equal(page.jobs[0].id, 'pending');
  assert.equal(host.store.getSnapshot(999).historyPage, 2);
  await host.store.pruneHistory(0);
  assert.equal(host.jobs.getHistory().length, 64);
  await host.store.pruneHistory(30);
  assert.deepEqual(host.jobs.getHistory().map((job) => job.id).sort(), ['delivered', 'interrupted', 'queued', 'running']);
  assert.equal(host.jobs.getJobs()[0].id, 'pending');
});
