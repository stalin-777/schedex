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

test('transient release errors cannot leave an active-process lock behind', async (t) => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-lock-release-'));
    let target;
    let fail = true;
    const host = createJobHost(folder, { io: { ...fs, unlink: async (...args) => {
      if (args[0] === target && fail) {
        fail = false;
        throw Object.assign(new Error('Transient sharing violation'), { code });
      }
      return fs.unlink(...args);
    } } });
    t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
    target = host.locks.getLockPath('release');
    const release = await host.locks.acquireFileLock('release');
    await release();
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    const next = await host.locks.acquireFileLock('release');
    assert.equal(typeof next, 'function');
    await next();
  }
});

test('concurrent calls to release share one cleanup instead of removing a successor', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-lock-release-once-'));
  let target;
  let unlinks = 0;
  const host = createJobHost(folder, { io: { ...fs,
    readFile: async (...args) => {
      const value = await fs.readFile(...args);
      if (args[0] === target) await new Promise((resolve) => setImmediate(resolve));
      return value;
    },
    unlink: async (...args) => {
      if (args[0] === target) unlinks++;
      return fs.unlink(...args);
    }
  } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  target = host.locks.getLockPath('once');
  const release = await host.locks.acquireFileLock('once');
  await Promise.all([release(), release()]);
  assert.equal(unlinks, 1);
});

test('release retries recheck ownership after a different generation takes the path', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-lock-release-generation-'));
  let target;
  let replace = true;
  const successor = { pid: process.pid, hostname: os.hostname(), token: 'successor', createdAt: Date.now() };
  const host = createJobHost(folder, { io: { ...fs, unlink: async (...args) => {
    if (args[0] === target && replace) {
      replace = false;
      // The original owner was removed by another cleaner while unlink failed.
      await fs.unlink(target);
      await fs.writeFile(target, JSON.stringify(successor));
      throw Object.assign(new Error('Transient sharing violation'), { code: 'EPERM' });
    }
    return fs.unlink(...args);
  } } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  target = host.locks.getLockPath('generation');
  const release = await host.locks.acquireFileLock('generation');
  await release();
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), successor);
});

test('a permanent release failure is reported and cannot permit another owner', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-lock-release-denied-'));
  let target;
  const failure = Object.assign(new Error('Permission remains denied'), { code: 'EACCES' });
  const host = createJobHost(folder, { io: { ...fs, unlink: async (...args) => {
    if (args[0] === target) throw failure;
    return fs.unlink(...args);
  } } });
  t.after(async () => { host.jobs.dispose(); await fs.rm(folder, { recursive: true, force: true }); });
  target = host.locks.getLockPath('denied');
  const release = await host.locks.acquireFileLock('denied');
  await assert.rejects(release(), (error) => error === failure);
  assert.equal(await host.locks.acquireFileLock('denied'), null);
});
