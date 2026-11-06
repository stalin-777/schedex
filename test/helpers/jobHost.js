'use strict';

const fs = require('node:fs');
const fileSystem = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const { accountKey } = require('../../src/accountIdentity');
const TEST_ACCOUNT = { account: { type: 'chatgpt', email: 'test@example.test' } };
const TEST_ACCOUNT_KEY = accountKey(TEST_ACCOUNT);

// Each host gets its own module state and Memento cache, just like a VS Code window.
function createJobHost(storagePath, { runtime = {}, delivery, io = fileSystem, legacy = [], onChange = () => {}, bindAccount = true } = {}) {
  const modules = new Map();
  const notifications = [];
  const vscode = {
    env: { language: 'en' },
    window: Object.fromEntries(['showInformationMessage', 'showWarningMessage', 'showErrorMessage']
      .map((name) => [name, (message) => notifications.push(message)]))
  };
  const codex = {
    resolveCodexRuntime: async () => ({}),
    getAccountKey: async () => TEST_ACCOUNT_KEY,
    queuePrompt: async (_target, job) => ({ id: 'queue-1', clientUserMessageId: job.clientMessageId }),
    readHistoryProgress: async (target, jobs, stopped) => {
      const updates = [];
      for (const job of jobs) {
        if (stopped()) break;
        let changes;
        try { changes = { ...await runtime.getTaskProgress(target, job), statusError: null }; }
        catch (error) { changes = { statusError: error.message }; }
        updates.push({ id: job.id, changes: { ...changes, lastStatusCheckAt: Date.now() } });
      }
      return updates;
    },
    ...runtime
  };
  // Keep submission checks in the harness; individual fakes only simulate the RPC result.
  const queueWithChecks = codex.queuePrompt;
  codex.queuePrompt = async (target, job, beforeSubmit) => {
    const context = runtime.getAvailabilityContext ? await runtime.getAvailabilityContext(target, job) : { accountKey: TEST_ACCOUNT_KEY };
    await beforeSubmit({ request: async () => runtime.readAccount ? runtime.readAccount()
      : context.accountKey === TEST_ACCOUNT_KEY ? TEST_ACCOUNT
        : { account: { type: 'chatgpt', email: 'changed@example.test' } } }, { model: context.model });
    return queueWithChecks(target, job);
  };

  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const filename = path.join(__dirname, '../../src', `${name}.js`);
    const mod = new Module(filename);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    modules.set(name, mod);
    mod.require = function(request) {
      if (request === 'vscode') return vscode;
      if (request === './runtime') return codex;
      if (request === './directDelivery' && delivery) return delivery;
      if (request === './i18n') return { s: (key) => key };
      if (request === 'fs/promises') return io;
      if (['./jobStore', './jobLocks', './jobTimers', './directDelivery', './availability'].includes(request)) return load(request.slice(2));
      return Module.prototype.require.call(this, request);
    };
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return mod.exports;
  }

  const bind = (job) => bindAccount ? { accountKey: TEST_ACCOUNT_KEY, ...job } : job;
  const data = new Map([['schedex.jobs.v1', structuredClone(legacy.map(bind))]]);
  const context = {
    globalStorageUri: { fsPath: storagePath },
    globalState: {
      get: (key, fallback) => data.get(key) ?? fallback,
      update: async (key, value) => data.set(key, structuredClone(value))
    }
  };
  const jobs = load('jobs');
  jobs.initialize(context, onChange);
  const upsert = jobs.upsertJob;
  jobs.upsertJob = (job) => upsert(bind(job));
  return { jobs, store: load('jobStore'), locks: load('jobLocks'), availability: load('availability'), notifications };
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for job state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

module.exports = { createJobHost, until };
