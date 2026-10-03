'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { joinPath: (...parts) => parts.join('/') } };
  return originalLoad.call(this, request, parent, isMain);
};
const { schedulerHtml } = require('../src/schedulerView');
Module._load = originalLoad;

const id = '12345678-1234-4234-8234-123456789abc';
const webview = { cspSource: 'vscode-resource:', asWebviewUri: (uri) => uri };

function setup() {
  const dom = new JSDOM(schedulerHtml(webview, '/extension'), { runScripts: 'outside-only', url: 'https://example.test' });
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (msg) => sent.push(msg) });
  dom.window.scrollTo = () => {};
  for (const script of dom.window.document.querySelectorAll('script[src]')) {
    const file = path.basename(script.getAttribute('src'));
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../media', file), 'utf8'));
  }
  const message = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { dom, sent, message, document: dom.window.document };
}

test('saved task moves to the list; form keeps values and can edit the task', () => {
  const { dom, sent, message, document } = setup();
  assert.equal(sent[0].type, 'ready');
  const sendAt = new Date(2027, 0, 12, 14, 5).getTime();
  message({ type: 'state', threads: [{ id, name: 'Existing thread', preview: '' }], selectedThreadId: id, prompt: 'Continue', sendAtMs: sendAt, rateNote: '' });
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).type, 'save');
  assert.equal(sent.at(-1).threadId, id);
  const job = { id: 'job-1', threadId: id, threadName: 'Existing thread', threadMode: 'existing', prompt: 'Continue', sendAt, status: 'scheduled' };
  message({ type: 'jobs', jobs: [job] });
  message({ type: 'saved', message: 'Scheduled' });
  assert.match(document.getElementById('jobList').textContent, /Existing thread/);
  assert.equal(document.getElementById('prompt').value, 'Continue');
  assert.equal(document.getElementById('date').value, '2027/01/12');
  assert.equal(document.getElementById('threadSearch').value, 'Existing thread');
  assert.equal(document.getElementById('schedule').disabled, false);

  document.getElementById('minutePlus').click();
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, null);
  assert.equal(sent.at(-1).minute, '06');
  message({ type: 'saved', message: 'Scheduled another task' });

  document.querySelector('.job-actions button').click();
  assert.equal(document.getElementById('prompt').value, 'Continue');
  assert.equal(document.getElementById('date').value, '2027/01/12');
  document.getElementById('prompt').value = 'Continue with tests';
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, 'job-1');
  assert.equal(sent.at(-1).prompt, 'Continue with tests');
  message({ type: 'saved', message: 'Updated' });
  assert.equal(document.getElementById('prompt').value, 'Continue with tests');
  assert.equal(document.getElementById('schedule').textContent, 'Schedule');
  dom.window.close();
});

test('new-thread mode submits without a selected existing thread', () => {
  const { dom, sent, message, document } = setup();
  message({ type: 'state', threads: [], jobs: [], prompt: '', sendAtMs: Date.now() + 600000, rateNote: '' });
  const newMode = document.getElementById('newMode');
  newMode.checked = true;
  newMode.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('existingThreadFields').hidden, true);
  assert.equal(document.getElementById('schedule').disabled, false);
  document.getElementById('prompt').value = 'New task';
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).type, 'save');
  assert.equal(sent.at(-1).threadMode, 'new');
  assert.equal(sent.at(-1).threadId, '');
  dom.window.close();
});

test('first recent thread is selected when current thread cannot be identified', () => {
  const { dom, message, document } = setup();
  message({
    type: 'state',
    threads: [{ id, name: 'Previous task', preview: '' }],
    selectedThreadId: null,
    jobs: [],
    prompt: '',
    sendAtMs: Date.now() + 600000
  });
  assert.equal(document.getElementById('threadSearch').value, 'Previous task');
  assert.equal(document.getElementById('schedule').disabled, false);
  dom.window.close();
});

test('late save responses for A cannot complete or unlock the current save of B', () => {
  const { dom, sent, message, document } = setup();
  const otherId = '23456789-1234-4234-8234-123456789abc';
  const sendAt = new Date(2099, 0, 12, 14, 5).getTime();
  const threads = [{ id, name: 'A' }, { id: otherId, name: 'B' }];
  const jobs = threads.map((thread) => ({
    id: 'job-' + thread.name, threadId: thread.id, threadName: thread.name,
    threadMode: 'existing', prompt: 'Prompt ' + thread.name, sendAt, status: 'scheduled'
  }));
  message({ type: 'state', threads, jobs, selectedThreadId: id, sendAtMs: sendAt });
  document.querySelectorAll('.job-actions button')[0].click();
  document.getElementById('schedule').click();
  const saveA = sent.at(-1);
  document.querySelectorAll('.job-actions button')[2].click();
  document.getElementById('schedule').click();
  const saveB = sent.at(-1);
  message({ type: 'saved', requestId: saveA.requestId, message: 'Saved A' });
  message({ type: 'validation', requestId: saveA.requestId, error: 'Invalid A' });
  assert.equal(document.getElementById('schedule').disabled, true);
  assert.equal(document.getElementById('prompt').value, 'Prompt B');
  assert.equal(document.getElementById('error').textContent, '');
  message({ type: 'validation', requestId: saveB.requestId, error: 'Invalid B' });
  assert.equal(document.getElementById('schedule').disabled, false);
  assert.equal(document.getElementById('error').textContent, 'Invalid B');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, 'job-B');
  assert.equal(sent.at(-1).threadId, otherId);
  message({ type: 'saved', requestId: sent.at(-1).requestId, message: 'Saved B' });
  assert.equal(document.getElementById('schedule').textContent, 'Schedule');
  assert.equal(document.getElementById('prompt').value, 'Prompt B');
  dom.window.close();
});
