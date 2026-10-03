'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jobsPath = require.resolve('../src/jobs');

const threadId = '12345678-1234-4123-8123-123456789abc';
let created = 0;
let createdCwd;
let queued = 0;
const queuedJobs = [];
const messages = [];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {
    env: { language: 'en' },
    window: {
      showInformationMessage: (message) => messages.push(message),
      showWarningMessage: (message) => messages.push(message),
      showErrorMessage: (message) => messages.push(message)
    }
  };
  if (request === './runtime' && parent?.filename === jobsPath) return {
    resolveCodexRuntime: async () => ({ command: 'codex', baseArgs: [] }),
    getWorkspaceCwdForCodex: () => '/other-workspace',
    createCodexThread: async (_runtime, cwd) => { created++; createdCwd = cwd; return threadId; },
    runCodex: async (_runtime, args) => {
      queued++;
      queuedJobs.push(args);
      return queued === 1 ? { code: 1, stderr: 'rate limit' } : { code: 0 };
    }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const jobs = require('../src/jobs');
Module._load = originalLoad;

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for scheduled send');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('new thread is created at send time and reused on retry', async () => {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-new-thread-'));
  const data = new Map();
  const globalState = {
    get: (key, fallback) => data.get(key) ?? fallback,
    update: async (key, value) => data.set(key, value)
  };
  jobs.initialize({ globalState, globalStorageUri: { fsPath: storagePath } }, () => {});
  try {
    const job = {
      id: 'new-thread-job', threadMode: 'new', threadId: null,
      prompt: 'Run this', sendAt: Date.now() + 150, cwd: '/original-workspace',
      status: 'scheduled', attempts: 0
    };
    await jobs.upsertJob(job);
    assert.equal(created, 0);
    jobs.scheduleTimer(job);
    await until(() => jobs.getJobs()[0]?.attempts === 1 && messages.length === 1);

    assert.equal(created, 1);
    assert.equal(createdCwd, '/original-workspace');
    assert.equal(queued, 1);
    assert.equal(jobs.getJobs()[0].threadId, threadId);
    assert.equal(jobs.getJobs()[0].status, 'scheduled');
    assert.deepEqual(queuedJobs[0], ['queue', '--thread', threadId, '--message', 'Run this']);

    const retried = await jobs.updateEditableJob(job.id, { sendAt: Date.now() + 30 });
    jobs.scheduleTimer(retried);
    await until(() => jobs.getJobs().length === 0 && messages.length === 2);
    assert.equal(created, 1);
    assert.equal(queued, 2);
    assert.deepEqual(queuedJobs[1], queuedJobs[0]);
    assert.equal(messages.length, 2);
  } finally {
    jobs.dispose();
    await fs.rm(storagePath, { recursive: true, force: true });
  }
});
