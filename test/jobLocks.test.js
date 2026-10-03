'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { createJobHost } = require('./helpers/jobHost');

const deadOwner = (token) => ({ pid: 2147483647, hostname: os.hostname(), token, createdAt: Date.now() });

test('competing stale-lock cleaners cannot both acquire the job; completion survives release', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-locks-'));
  let lockPath;
  let readers = 0;
  let resume;
  const bothReadOldOwner = new Promise((resolve) => { resume = resolve; });
  const io = {
    ...fs,
    readFile: async (...args) => {
      const data = await fs.readFile(...args);
      if (args[0] === lockPath && JSON.parse(data).token === 'dead' && readers < 2) {
        if (++readers === 2) resume();
        await bothReadOldOwner;
      }
      return data;
    }
  };
  const hosts = [createJobHost(folder, { io }), createJobHost(folder, { io })];
  t.after(async () => {
    hosts.forEach((host) => host.jobs.dispose());
    await fs.rm(folder, { recursive: true, force: true });
  });
  lockPath = hosts[0].locks.getLockPath('job:race');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(deadOwner('dead')));
  const releases = await Promise.all(hosts.map((host) => host.locks.acquireFileLock('job:race')));
  assert.equal(releases.filter(Boolean).length, 1);
  const winner = releases.find(Boolean);
  await winner.markCompleted();
  await winner();
  assert.equal(await hosts[1].locks.isJobCompleted('race'), true);
  assert.equal(await hosts[1].locks.acquireFileLock('job:race'), null);
});

test('a dead cleaner can be replaced by the next generation', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-reaper-'));
  const host = createJobHost(folder);
  t.after(async () => {
    host.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  const lockPath = host.locks.getLockPath('job:recover');
  const token = 'dead-lock';
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
  const reapers = `${lockPath}.reapers-${key}`;
  await fs.mkdir(reapers, { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(deadOwner(token)));
  await fs.writeFile(path.join(reapers, '0.json'), JSON.stringify(deadOwner('dead-cleaner')));
  const release = await host.locks.acquireFileLock('job:recover');
  assert.equal(typeof release, 'function');
  assert.ok((await fs.readdir(reapers)).includes('1.json'));
  await release();
});

test('failure while writing a new lock does not leave a lock behind', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-lock-failure-'));
  let target;
  let fail = true;
  const io = {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args);
      if (args[0] !== target || !fail) return handle;
      fail = false;
      return { close: () => handle.close(), writeFile: async () => { throw new Error('Injected write failure'); } };
    }
  };
  const host = createJobHost(folder, { io });
  t.after(async () => {
    host.jobs.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  target = host.locks.getLockPath('broken');
  await assert.rejects(host.locks.acquireFileLock('broken'), /Injected write failure/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const release = await host.locks.acquireFileLock('broken');
  assert.equal(typeof release, 'function');
  await release();
});
