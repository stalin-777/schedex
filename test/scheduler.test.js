'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { until } = require('./helpers/jobHost');
const schedulerPath = require.resolve('../src/scheduler');

const saved = [];
const posted = [];
let snapshot = 'thread-snapshot';
let snapshotReads = 0;
let modelLoader;
let threadLoader;
let rateLoader;
let activeThreadId = null;
let currentAccount = 'saved-account';
let onMessage;
let useRealView = false;
let sendToView;
const panel = {
  webview: {
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri) => uri,
    postMessage: async (message) => { posted.push(message); sendToView?.(message); return true; },
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
  getAccountKey: async () => { if (currentAccount instanceof Error) throw currentAccount; return currentAccount; },
  getRateLimitSuggestion: async () => rateLoader ? rateLoader() : null,
  getThreadRevision: async () => { snapshotReads++; if (snapshot instanceof Error) throw snapshot; return snapshot; },
  getAvailableModels: async () => modelLoader ? modelLoader() : [
    { id: 'test-model', name: 'Test model', efforts: ['high', 'xhigh'], defaultEffort: 'high' }
  ]
};
const threads = {
  resolveCurrentThreadIdNonInteractive: async () => activeThreadId,
  listRecentThreads: async (_runtime, onPage) => threadLoader ? threadLoader(onPage) : [],
  extractThreadId: (value) => /^[0-9a-f-]{36}$/.test(value) ? value : null,
  getRememberedThreadBinding: () => null
};
const jobs = {
  getJobs: () => saved,
  getHistory: () => [],
  getSnapshot: () => ({ jobs: saved, history: [] }),
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
    if (request === './schedulerView') return { schedulerHtml: (...args) => useRealView ? schedulerHtml(...args) : '<html></html>' };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { schedulerHtml } = require('../src/schedulerView');
const scheduler = require('../src/scheduler');
Module._load = originalLoad;

test('new-thread task stays independent of existing threads while it is edited', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  await onMessage({ type: 'save', threadMode: 'new', prompt: 'First', date: '2099/01/12', hour: '14', minute: '05' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].threadId, null);
  assert.equal(saved[0].threadMode, 'new');
  assert.equal(posted.at(-1).type, 'saved');
  await onMessage({ type: 'save', jobId: saved[0].id, threadMode: 'new', prompt: 'Edited', date: '2099/01/13', hour: '15', minute: '06' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].prompt, 'Edited');
  assert.equal(saved[0].threadId, null);
  scheduler.dispose();
});

test('captures the active conversation before opening Schedex changes focus', async (t) => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const create = vscode.window.createWebviewPanel;
  activeThreadId = id;
  vscode.window.createWebviewPanel = () => { activeThreadId = null; return panel; };
  t.after(() => { vscode.window.createWebviewPanel = create; activeThreadId = null; scheduler.dispose(); });
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  await onMessage({ type: 'ready' });
  const state = posted.findLast((message) => message.type === 'state');
  assert.equal(state.selectedThreadId, id);
  assert.equal(state.threads[0].id, id);
});

test('publishes conversations while model, quota, and later-page requests are still pending', async (t) => {
  let finishModels, finishRate, finishThreads;
  modelLoader = () => new Promise((resolve) => { finishModels = resolve; });
  rateLoader = () => new Promise((resolve) => { finishRate = resolve; });
  threadLoader = async (onPage) => {
    const threads = [{ id: '12345678-1234-4234-8234-123456789abc', name: 'Recent' }];
    await onPage(threads);
    await new Promise((resolve) => { finishThreads = resolve; });
    return threads;
  };
  t.after(() => { modelLoader = threadLoader = rateLoader = undefined; scheduler.dispose(); });
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  const before = posted.length;
  const loading = onMessage({ type: 'ready' });
  await until(() => Boolean(finishThreads && finishModels && finishRate));
  const messages = posted.slice(before);
  const state = messages.find((message) => message.type === 'state');
  assert.equal(state.selectedThreadId, null);
  assert.match(state.threadSelectionNote, /Choose/);
  assert.equal(messages.find((message) => message.type === 'threads').threads[0].name, 'Recent');
  assert.equal(messages.some((message) => message.type === 'models' || message.type === 'rateSuggestion'), false);
  finishThreads();
  await until(() => posted.slice(before).some((message) => message.type === 'threads' && !message.loadingThreads));
  finishModels([]); finishRate(null);
  await loading;
});

test('task model settings are validated, saved, edited, and reset to defaults', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  await onMessage({ type: 'ready' });
  const models = posted.findLast((message) => message.type === 'models');
  assert.deepEqual(models.models[0].efforts, ['high', 'xhigh']);
  const message = { type: 'save', threadMode: 'new', prompt: 'With model', date: '2099/01/12', hour: '14', minute: '05',
    model: 'test-model', reasoningEffort: 'xhigh' };
  const before = saved.length;
  await onMessage({ ...message, reasoningEffort: 'unsupported', requestId: 'bad' });
  assert.equal(saved.length, before);
  assert.equal(posted.at(-1).type, 'validation');
  assert.equal(posted.at(-1).requestId, 'bad');
  await onMessage(message);
  const job = saved.at(-1);
  assert.equal(job.model, 'test-model');
  assert.equal(job.reasoningEffort, 'xhigh');
  await onMessage({ ...message, jobId: job.id, reasoningEffort: 'high' });
  assert.equal(saved.at(-1).reasoningEffort, 'high');
  await onMessage({ ...message, jobId: job.id, model: null, reasoningEffort: null });
  assert.equal(saved.at(-1).model, null);
  assert.equal(saved.at(-1).reasoningEffort, null);
  scheduler.dispose();
});

test('availability mode ignores date fields and preserves its deadline when editing the prompt', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  const message = { type: 'save', threadMode: 'new', sendMode: 'available', waitDays: '8', prompt: 'Wait', date: 'invalid' };
  const before = saved.length;
  await onMessage({ ...message, waitDays: '0' });
  await onMessage({ ...message, waitDays: '31' });
  assert.equal(saved.length, before);
  assert.equal(posted.at(-1).type, 'validation');
  await onMessage(message);
  const job = saved.at(-1);
  assert.equal(job.sendMode, 'available');
  assert.equal(job.waitDays, 8);
  assert.ok(job.availabilityRequestedAt <= Date.now());
  assert.ok(job.expiresAt > Date.now() + 7 * 86400000);
  assert.ok(job.nextCheckAt <= Date.now());
  await onMessage({ ...message, jobId: job.id, prompt: 'Edited waiting task' });
  assert.equal(saved.at(-1).expiresAt, job.expiresAt);
  assert.equal(saved.at(-1).prompt, 'Edited waiting task');
  scheduler.dispose();
});

test('existing-thread model overrides are rejected and legacy tasks can be saved with conversation defaults', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  await onMessage({ type: 'ready' });
  const message = { type: 'save', threadMode: 'existing', threadId: '12345678-1234-4234-8234-123456789abc',
    prompt: 'Continue', date: '2099/01/12', hour: '14', minute: '05' };
  const before = saved.length;
  for (const sendMode of ['time', 'available']) {
    for (const settings of [{ model: 'test-model', reasoningEffort: 'xhigh' }, { reasoningEffort: 'high' }]) {
      await onMessage({ ...message, sendMode, ...settings, requestId: 'old-form' });
      assert.equal(saved.length, before);
      assert.equal(posted.at(-1).type, 'validation');
      assert.equal(posted.at(-1).requestId, 'old-form');
      assert.match(posted.at(-1).error, /only for new conversations/);
    }
  }
  saved.push({ id: 'legacy-existing', ...message, model: 'test-model', reasoningEffort: 'xhigh', status: 'paused' });
  await onMessage({ ...message, jobId: 'legacy-existing', model: null, reasoningEffort: null });
  const edited = saved.find((job) => job.id === 'legacy-existing');
  assert.equal(posted.at(-1).type, 'saved');
  assert.equal(edited.model, null);
  assert.equal(edited.reasoningEffort, null);
  assert.equal(edited.threadMode, 'existing');
  assert.equal(edited.threadId, message.threadId);
  scheduler.dispose();
});

test('Continue defaults to skipping changed history, explicit policy wins, and edits take a fresh snapshot', async () => {
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler();
  const message = { type: 'save', threadMode: 'existing', threadId: '12345678-1234-4234-8234-123456789abc',
    prompt: 'Продолжай', date: '2099/01/12', hour: '14', minute: '05' };
  await onMessage(message);
  const job = saved.at(-1);
  assert.equal(job.stalePolicy, 'skip');
  assert.equal(job.threadRevision, snapshot);
  snapshot = 'new-snapshot';
  await onMessage({ ...message, jobId: job.id, stalePolicy: 'confirm' });
  assert.equal(saved.at(-1).threadRevision, snapshot);
  assert.equal(saved.at(-1).stalePolicy, 'confirm');
  const count = snapshotReads;
  await onMessage({ ...message, stalePolicy: 'send' });
  assert.equal(saved.at(-1).stalePolicy, 'send');
  assert.equal(snapshotReads, count);
  await onMessage({ ...message, prompt: 'Review the implementation' });
  assert.equal(saved.at(-1).stalePolicy, 'send');
  snapshot = new Error('Cannot read Codex history');
  const before = saved.length;
  await onMessage({ ...message, requestId: 'snapshot-error' });
  assert.equal(saved.length, before);
  assert.equal(posted.at(-1).type, 'validation');
  assert.equal(posted.at(-1).requestId, 'snapshot-error');
  snapshot = 'thread-snapshot';
  scheduler.dispose();
});

test('command editing waits for panel initialization and switches an open panel to the selected job', async (t) => {
  scheduler.initialize({ extensionUri: '/extension' });
  const initialCount = saved.length;
  t.after(() => { scheduler.dispose(); saved.splice(initialCount); });
  const jobsToEdit = ['paused', 'expired', 'review'].map((status) => ({ id: 'edit-' + status,
    status, threadMode: 'new', prompt: status + ' prompt', sendMode: 'available', waitDays: 8,
    sendAt: Date.now(), expiresAt: Date.now() + 86400000 }));
  saved.push(...jobsToEdit);
  const firstMessage = posted.length;
  await scheduler.openScheduler([], jobsToEdit[0].id);
  assert.equal(posted.length, firstMessage, 'do not send edit data before the webview is ready');
  await onMessage({ type: 'ready' });
  assert.deepEqual(posted.findLast((message) => message.type === 'state').editJob, jobsToEdit[0]);
  assert.equal(posted.slice(firstMessage).some((message) => message.type === 'editJob'), false,
    'initial editing is part of the initial state, never replayed after loading');
  for (const job of jobsToEdit.slice(1)) {
    const before = posted.length;
    await scheduler.openScheduler([], job.id);
    assert.deepEqual(posted.slice(before), [{ type: 'editJob', job }]);
  }
  const before = posted.length;
  await scheduler.openScheduler();
  assert.equal(posted.length, before, 'ordinary opening must preserve the current form');
});

test('command edits apply immediately during background loading and noneditable jobs are rejected', async (t) => {
  scheduler.initialize({ extensionUri: '/extension' });
  const initialCount = saved.length;
  let finishLoading;
  modelLoader = () => new Promise((resolve) => { finishLoading = resolve; });
  t.after(() => { modelLoader = undefined; scheduler.dispose(); saved.splice(initialCount); });
  const first = { id: 'loading-first', status: 'paused', threadMode: 'new', prompt: 'First' };
  const latest = { id: 'loading-latest', status: 'review', threadMode: 'new', prompt: 'Latest' };
  saved.push(first, latest, { id: 'already-sending', status: 'sending' });
  await scheduler.openScheduler([], first.id);
  const loading = onMessage({ type: 'ready' });
  await until(() => Boolean(finishLoading));
  assert.deepEqual(posted.findLast((message) => message.type === 'state').editJob, first);
  const before = posted.length;
  await scheduler.openScheduler([], latest.id);
  assert.deepEqual(posted.slice(before), [{ type: 'editJob', job: latest }]);
  const edits = posted.filter((message) => message.type === 'editJob').length;
  finishLoading([]);
  await loading;
  assert.equal(posted.filter((message) => message.type === 'editJob').length, edits);
  for (const id of ['removed', 'already-sending']) {
    await scheduler.openScheduler([], id);
    assert.equal(posted.at(-1).type, 'validation');
    assert.match(posted.at(-1).error, /changed|being sent/);
  }
});

test('real webview edits to B survive completion of background loading after command-opening A', async (t) => {
  let finishModels, finishRate;
  const handled = [];
  const before = saved.length;
  modelLoader = () => new Promise((resolve) => { finishModels = resolve; });
  rateLoader = () => new Promise((resolve) => { finishRate = resolve; });
  const sendAt = new Date(2099, 0, 12, 14, 5).getTime();
  const first = { id: 'command-A', status: 'paused', threadMode: 'new', prompt: 'Initial A', sendAt,
    model: 'test-model', reasoningEffort: 'high' };
  const second = { ...first, id: 'card-B', prompt: 'Initial B', reasoningEffort: 'xhigh' };
  saved.push(first, second);
  useRealView = true;
  scheduler.initialize({ extensionUri: '/extension' });
  await scheduler.openScheduler([], first.id);
  const dom = new JSDOM(panel.webview.html, { runScripts: 'outside-only', url: 'https://example.test' });
  t.after(async () => {
    finishModels?.([]); finishRate?.(null);
    await Promise.allSettled(handled);
    sendToView = undefined; useRealView = false;
    modelLoader = rateLoader = undefined;
    scheduler.dispose(); saved.splice(before); dom.window.close();
  });
  dom.window.scrollTo = () => {};
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message) => handled.push(onMessage(message)) });
  sendToView = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const document = dom.window.document;
  for (const script of document.querySelectorAll('script[src]')) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../media', path.basename(script.getAttribute('src'))), 'utf8'));
  }
  await until(() => Boolean(finishModels && finishRate));
  assert.equal(document.getElementById('prompt').value, first.prompt, 'apply the command before background requests finish');
  const card = Array.from(document.querySelectorAll('#jobList .job-card')).find((element) => element.textContent.includes(second.prompt));
  card.querySelector('button').click();
  document.getElementById('prompt').value = 'User edits to B';
  document.getElementById('prompt').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  finishModels([{ id: 'test-model', name: 'Test model', efforts: ['high', 'xhigh'] }]);
  finishRate({ sendAtMs: sendAt + 86400000, resetAtMs: sendAt });
  await handled[0];
  assert.equal(document.getElementById('prompt').value, 'User edits to B');
  assert.equal(document.getElementById('reasoningEffort').value, 'xhigh');
  assert.equal(document.getElementById('date').value, '2099/01/12');
  document.getElementById('schedule').click();
  await handled.at(-1);
  assert.equal(saved.find((job) => job.id === first.id).prompt, first.prompt);
  assert.equal(saved.find((job) => job.id === second.id).prompt, 'User edits to B');
  assert.equal(saved.find((job) => job.id === second.id).reasoningEffort, 'xhigh');
});

test('both send modes bind the account at save time and only explicit resaving changes it', async (t) => {
  scheduler.initialize({ extensionUri: '/extension' });
  const before = saved.length;
  t.after(() => { scheduler.dispose(); saved.splice(before); currentAccount = 'saved-account'; });
  await scheduler.openScheduler();
  for (const sendMode of ['time', 'available']) {
    const message = { type: 'save', threadMode: 'new', prompt: 'Sensitive', sendMode, waitDays: 8,
      date: '2099/01/12', hour: '14', minute: '05' };
    currentAccount = 'work';
    await onMessage(message);
    const job = saved.at(-1);
    assert.equal(job.accountKey, 'work');
    currentAccount = new Error('Authentication unavailable');
    await onMessage({ ...message, jobId: job.id, requestId: 'auth-failed' });
    assert.equal(posted.at(-1).type, 'validation');
    assert.equal(saved.find((item) => item.id === job.id).accountKey, 'work');
    currentAccount = 'personal';
    await onMessage({ ...message, jobId: job.id });
    assert.equal(saved.find((item) => item.id === job.id).accountKey, 'personal');
  }
});
