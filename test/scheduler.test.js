'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const schedulerPath = require.resolve('../src/scheduler');

const newThreadId = '23456789-1234-4234-8234-123456789abc';
const saved = [];
const posted = [];
let onMessage;
let createCalls = 0;
const panel = {
  webview: {
    postMessage: async (message) => { posted.push(message); return true; },
    onDidReceiveMessage: (callback) => { onMessage = callback; return { dispose() {} }; }
  },
  onDidDispose: () => ({ dispose() {} }),
  reveal() {}
};
const vscode = {
  env: { language: 'en' },
  ViewColumn: { Active: 1 },
  Uri: { joinPath: (...parts) => parts.join('/') },
  window: { createWebviewPanel: () => panel, showInformationMessage() {} }
};
const runtime = {
  resolveCodexRuntime: async () => ({}),
  getRateLimitSuggestion: async () => null,
  createCodexThread: async () => { createCalls++; return newThreadId; }
};
const threads = {
  resolveCurrentThreadIdNonInteractive: async () => null,
  listRecentThreads: async () => [],
  extractThreadId: (value) => /^[0-9a-f-]{36}$/.test(value) ? value : null,
  getRememberedThreadBinding: () => null
};
const jobs = {
  getJobs: () => saved,
  upsertJob: async (job) => { saved.push(job); },
  updateEditableJob: async (id, changes) => {
    const index = saved.findIndex((job) => job.id === id);
    if (index < 0) return null;
    saved[index] = { ...saved[index], ...changes };
    return saved[index];
  },
  removeEditableJob: async () => false,
  scheduleTimer() {},
  notifyChanged() {}
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (parent?.filename === schedulerPath) {
    if (request === './runtime') return runtime;
    if (request === './threads') return threads;
    if (request === './jobs') return jobs;
    if (request === './schedulerView') return { schedulerHtml: () => '<html></html>' };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const scheduler = require('../src/scheduler');
Module._load = originalLoad;

test('new-thread task stays independent of existing threads while it is edited', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  await onMessage({ type: 'save', threadMode: 'new', prompt: 'First', date: '2099/01/12', hour: '14', minute: '05' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].threadId, null);
  assert.equal(saved[0].threadMode, 'new');
  assert.equal(createCalls, 0);
  assert.equal(posted.at(-1).type, 'saved');
  await onMessage({ type: 'save', jobId: saved[0].id, threadMode: 'new', prompt: 'Edited', date: '2099/01/13', hour: '15', minute: '06' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].prompt, 'Edited');
  assert.equal(saved[0].threadId, null);
  assert.equal(createCalls, 0);
  scheduler.dispose();
});
