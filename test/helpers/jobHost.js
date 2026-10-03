'use strict';

const fs = require('node:fs');
const fileSystem = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');

// Each host gets its own module state and Memento cache, just like a VS Code window.
function createJobHost(storagePath, { runtime = {}, io = fileSystem, legacy = [], onChange = () => {} } = {}) {
  const modules = new Map();
  const notifications = [];
  const vscode = {
    env: { language: 'en' },
    window: Object.fromEntries(['showInformationMessage', 'showWarningMessage', 'showErrorMessage']
      .map((name) => [name, (message) => notifications.push(message)]))
  };
  const codex = {
    resolveCodexRuntime: async () => ({}),
    runCodex: async () => ({ code: 0 }),
    ...runtime
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
      if (request === './i18n') return { s: (key) => key };
      if (request === 'fs/promises') return io;
      if (['./jobStore', './jobLocks', './jobTimers'].includes(request)) return load(request.slice(2));
      return Module.prototype.require.call(this, request);
    };
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return mod.exports;
  }

  const data = new Map([['schedex.jobs.v1', structuredClone(legacy)]]);
  const context = {
    globalStorageUri: { fsPath: storagePath },
    globalState: {
      get: (key, fallback) => data.get(key) ?? fallback,
      update: async (key, value) => data.set(key, structuredClone(value))
    }
  };
  const jobs = load('jobs');
  jobs.initialize(context, onChange);
  return { jobs, store: load('jobStore'), locks: load('jobLocks'), notifications };
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for job state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

module.exports = { createJobHost, until };
