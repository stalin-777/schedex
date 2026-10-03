'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { acquireFileLock } = require('./jobLocks');

const JOBS_KEY = 'schedex.jobs.v1';
const JOBS_LOCK_WAIT_MS = 30 * 1000;

let extContext;
let writes = Promise.resolve();

function initialize(context) {
  extContext = context;
}

function getJobs() {
  if (!extContext) return [];
  try {
    return readJobs();
  } catch (err) {
    console.error('Schedex could not read its job store:', err);
    return [];
  }
}

function getLegacyJobs() {
  const jobs = extContext?.globalState.get(JOBS_KEY, []);
  return Array.isArray(jobs) ? jobs.slice() : [];
}

function getJobsFilePath() {
  const storagePath = extContext?.globalStorageUri?.fsPath;
  // globalState remains the migration source only; this shared file is the live job store.
  return storagePath ? path.join(storagePath, 'schedex.jobs.v1.json') : null;
}

function readJobs(filePath = getJobsFilePath()) {
  if (filePath) {
    try {
      const jobs = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(jobs)) throw new Error('Schedex job store must contain a JSON array');
      return jobs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return getLegacyJobs();
}

function watchJobs(onChange) {
  const filePath = getJobsFilePath();
  if (!filePath) return () => {};
  const context = extContext;
  const folder = path.dirname(filePath);
  let watcher;
  let stopped = false;
  fs.mkdir(folder, { recursive: true }).then(() => {
    if (stopped || extContext !== context) return;
    watcher = fsSync.watch(folder, (_eventType, filename) => {
      if (!filename || filename.toString() === path.basename(filePath)) onChange();
    });
    watcher.on('error', (err) => console.error('Schedex job-store watcher failed:', err));
    onChange();
  }).catch((err) => console.error('Schedex could not watch its job store:', err));
  return () => {
    stopped = true;
    watcher?.close();
  };
}

async function writeJobsFileAtomic(filePath, jobs) {
  const folder = path.dirname(filePath);
  await fs.mkdir(folder, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(jobs));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

function updateJobs(mutator) {
  const next = writes.then(async () => {
    if (!extContext) return;
    // The in-memory queue only covers this extension host; the file lock serializes other windows.
    const release = await acquireFileLock('jobs', JOBS_LOCK_WAIT_MS);
    if (!release) throw new Error('Timed out waiting for the Schedex job storage lock');
    try {
      const filePath = getJobsFilePath();
      const jobs = readJobs(filePath);
      const result = mutator(jobs);
      if (filePath) {
        await writeJobsFileAtomic(filePath, jobs);
      } else {
        await extContext.globalState.update(JOBS_KEY, jobs);
      }
      return result;
    } finally {
      await release();
    }
  });
  writes = next.catch(() => {});
  return next;
}

function upsertJob(job) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((x) => x.id === job.id);
    if (index >= 0) jobs[index] = job; else jobs.push(job);
  });
}

function updateEditableJob(id, changes) {
  return updateJob(id, { ...changes, status: 'scheduled', attempts: 0, lastError: null }, isEditable);
}

function updateSendingJob(id, changes) {
  return updateJob(id, changes, (job) => job.status === 'sending');
}

function updateJob(id, changes, canUpdate) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && canUpdate(job));
    if (index < 0) return null;
    jobs[index] = { ...jobs[index], ...changes, id };
    return jobs[index];
  });
}

function claimScheduledJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && job.status === 'scheduled');
    if (index < 0) return null;
    // Recheck under the storage lock: another window may have postponed this job.
    if (jobs[index].sendAt > Date.now()) return jobs[index];
    jobs[index] = { ...jobs[index], status: 'sending' };
    return jobs[index];
  });
}

function isEditable(job) {
  return job.status === 'scheduled' || job.status === 'failed';
}

function removeEditableJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((job) => job.id === id && isEditable(job));
    if (index < 0) return false;
    jobs.splice(index, 1);
    return true;
  });
}

function removeJob(id) {
  return updateJobs((jobs) => {
    const index = jobs.findIndex((x) => x.id === id);
    if (index >= 0) jobs.splice(index, 1);
  });
}

module.exports = {
  initialize,
  getJobs,
  getJobsFilePath,
  watchJobs,
  updateJobs,
  claimScheduledJob,
  updateSendingJob,
  upsertJob,
  updateEditableJob,
  removeEditableJob,
  removeJob
};
