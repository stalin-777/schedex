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
