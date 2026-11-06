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

test('command edit requests fill the selected task and replace a previously edited task', () => {
  const { dom, sent, message, document } = setup();
  const sendAt = new Date(2099, 0, 12, 14, 5).getTime();
  message({ type: 'state', threads: [], jobs: [], models: [
    { id: 'large', name: 'Large', efforts: ['high', 'xhigh'] }
  ], sendAtMs: sendAt });
  const first = { id: 'paused', status: 'paused', threadMode: 'new', prompt: 'Paused prompt',
    sendMode: 'available', waitDays: 12, expiresAt: Date.now() + 12 * 86400000,
    sendAt, model: 'large', reasoningEffort: 'xhigh' };
  message({ type: 'editJob', job: first });
  assert.equal(document.getElementById('prompt').value, first.prompt);
  assert.equal(document.getElementById('newMode').checked, true);
  assert.equal(document.getElementById('whenAvailable').checked, true);
  assert.equal(document.getElementById('waitDays').value, '12');
  assert.equal(document.getElementById('model').value, 'large');
  assert.equal(document.getElementById('reasoningEffort').value, 'xhigh');
  assert.equal(document.getElementById('schedule').textContent, 'Save changes');
  assert.equal(document.getElementById('cancelEdit').hidden, false);
  document.getElementById('schedule').click();
  const firstSave = sent.at(-1);
  assert.equal(firstSave.jobId, first.id);
  const second = { id: 'review', status: 'review', threadMode: 'existing', threadId: id,
    threadName: 'Selected conversation', prompt: 'Review prompt', sendMode: 'time', sendAt, stalePolicy: 'confirm' };
  message({ type: 'editJob', job: second });
  assert.equal(document.getElementById('prompt').value, second.prompt);
  assert.equal(document.getElementById('existingMode').checked, true);
  assert.equal(document.getElementById('threadSearch').value, second.threadName);
  assert.equal(document.getElementById('atTime').checked, true);
  assert.equal(document.getElementById('date').value, '2099/01/12');
  assert.equal(document.getElementById('hour').value, '14');
  assert.equal(document.getElementById('minute').value, '05');
  message({ type: 'saved', requestId: firstSave.requestId, message: 'Old response' });
  assert.equal(document.getElementById('schedule').textContent, 'Save changes');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, second.id);
  assert.equal(sent.at(-1).threadId, id);
  assert.equal(sent.at(-1).prompt, second.prompt);
  assert.equal(sent.at(-1).stalePolicy, 'confirm');
  dom.window.close();
});

test('uncertain deliveries move to History without displaying cancellation or a fabricated finish time', () => {
  const { dom, message, document, sent } = setup();
  const job = { id: 'uncertain', status: 'review', sendAt: Date.now(), threadId: id, prompt: 'Maybe accepted' };
  message({ type: 'jobs', jobs: [job] });
  const move = Array.from(document.querySelectorAll('#jobList button')).find((button) => button.textContent === 'Move to History');
  assert.ok(move);
  move.click();
  assert.equal(sent.at(-1).type, 'remove');
  assert.equal(sent.at(-1).jobId, job.id);
  message({ type: 'jobs', jobs: [], history: [{ ...job, archivedAt: Date.now() }] });
  const history = document.getElementById('historyList');
  assert.equal(history.querySelector('.job-status').textContent, 'Needs review');
  assert.match(history.textContent, /does not cancel a prompt in Codex/);
  assert.doesNotMatch(history.textContent, /Cancelled|Finished:/);
  assert.equal(Array.from(history.querySelectorAll('button')).some((button) => button.textContent === 'Open in Codex'), true);
  dom.window.close();
});

test('task cards are paginated and history navigation requests just the selected page', () => {
  const { dom, sent, message, document } = setup();
  const jobs = Array.from({ length: 60 }, (_, i) => ({ id: 'job-' + i, prompt: 'Job ' + i,
    sendAt: Date.now() + i * 1000, status: 'scheduled' }));
  message({ type: 'jobs', jobs, history: [], historyPage: 0, historyTotal: 70, historyPageSize: 25 });
  assert.equal(document.querySelectorAll('#jobList .job-card').length, 25);
  document.getElementById('activeNext').click();
  assert.match(document.getElementById('jobList').textContent, /Job 25/);
  assert.equal(document.querySelectorAll('#jobList .job-card').length, 25);
  document.getElementById('historyNext').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'historyPage', page: 1 });
  message({ type: 'jobs', jobs, history: [{ id: 'old', status: 'completed', archivedAt: 10, sendAt: 10, prompt: 'Older result' }],
    historyPage: 1, historyTotal: 70, historyPageSize: 25 });
  assert.equal(document.getElementById('historyPageInfo').textContent, '2 / 3');
  assert.match(document.getElementById('historyList').textContent, /Older result/);
  document.getElementById('historyPrev').click();
  assert.equal(sent.at(-1).page, 0);
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

test('an unknown current conversation requires an explicit selection instead of using the most recent thread', () => {
  const { dom, message, document } = setup();
  message({
    type: 'state',
    threads: [{ id, name: 'Previous task', preview: '' }],
    selectedThreadId: null,
    threadSelectionNote: 'Choose the current conversation from the list.',
    jobs: [],
    prompt: '',
    sendAtMs: Date.now() + 600000
  });
  assert.equal(document.getElementById('threadSearch').value, '');
  assert.equal(document.getElementById('schedule').disabled, true);
  assert.match(document.getElementById('threadSelectionNote').textContent, /Choose/);
  document.getElementById('threadSearch').focus();
  document.querySelector('#threadResults .option').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(document.getElementById('threadSearch').value, 'Previous task');
  assert.equal(document.getElementById('schedule').disabled, false);
  assert.equal(document.getElementById('threadSelectionNote').textContent, '');
  dom.window.close();
});

test('progressive conversation loading preserves search, explicit selection, and edited time', () => {
  const { dom, message, document, sent } = setup();
  const threads = [{ id, name: 'First' }, { id: id.replace(/c$/, 'd'), name: 'Chosen' }];
  message({ type: 'state', threads: [], selectedThreadId: null, loadingThreads: true, sendAtMs: Date.now() + 600000 });
  const search = document.getElementById('threadSearch');
  search.value = 'Chosen';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  message({ type: 'threads', threads, selectedThreadId: threads[0].id, loadingThreads: true });
  assert.equal(search.value, 'Chosen');
  assert.equal(document.querySelectorAll('#threadResults .option').length, 1);
  document.querySelector('#threadResults .option').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  document.getElementById('hour').value = '15';
  document.getElementById('hour').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  document.getElementById('prompt').value = 'My prompt';
  message({ type: 'threads', threads, selectedThreadId: threads[0].id, loadingThreads: false });
  message({ type: 'models', models: [] });
  message({ type: 'rateSuggestion', sendAtMs: new Date(2099, 0, 12, 2, 0).getTime(), rateNote: 'Updated' });
  assert.equal(search.value, 'Chosen');
  assert.equal(document.getElementById('hour').value, '15');
  assert.equal(document.getElementById('prompt').value, 'My prompt');
  assert.equal(document.getElementById('sub').textContent, '');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).threadId, threads[1].id);
  dom.window.close();
});

test('a current-conversation command switches the destination but cannot change an edited task', () => {
  const { dom, message, document, sent } = setup();
  const otherId = id.replace(/c$/, 'd');
  message({ type: 'state', threads: [{ id, name: 'First' }], selectedThreadId: id, sendAtMs: Date.now() + 600000 });
  message({ type: 'selectThread', threadId: otherId });
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).threadId, otherId);
  message({ type: 'editJob', job: { id: 'editing', threadId: id, threadName: 'First', prompt: 'Edit', sendAt: Date.now() + 600000 } });
  message({ type: 'selectThread', threadId: otherId });
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, 'editing');
  assert.equal(sent.at(-1).threadId, id);
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
  Array.from(document.querySelectorAll('#jobList .job-actions button')).filter((button) => button.textContent === 'Edit')[1].click();
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

test('model picker limits efforts by model and preserves task settings across editing and hydration', () => {
  const { dom, sent, message, document } = setup();
  const sendAt = Date.now() + 600000;
  const model = document.getElementById('model');
  const effort = document.getElementById('reasoningEffort');
  const change = (element, value) => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const state = { type: 'state', threads: [{ id, name: 'Thread' }], sendAtMs: sendAt, models: [
    { id: 'large', name: 'Large', efforts: ['high', 'xhigh'], defaultEffort: 'high' },
    { id: 'small', name: 'Small', efforts: ['low'], defaultEffort: 'low' }
  ] };
  message(state);
  const newMode = document.getElementById('newMode');
  newMode.checked = true;
  newMode.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(model.value, '');
  assert.equal(effort.disabled, true);
  change(model, 'large');
  assert.deepEqual(Array.from(effort.options, (item) => item.value), ['', 'high', 'xhigh']);
  change(effort, 'xhigh');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).model, 'large');
  assert.equal(sent.at(-1).reasoningEffort, 'xhigh');
  message({ type: 'saved' });
  assert.equal(model.value, 'large');
  assert.equal(effort.value, 'xhigh');
  change(model, 'small');
  assert.equal(effort.value, '');
  assert.deepEqual(Array.from(effort.options, (item) => item.value), ['', 'low']);
  const job = { id: 'model-job', threadMode: 'new', threadId: id, model: 'large', reasoningEffort: 'xhigh', sendAt, status: 'scheduled' };
  message({ type: 'jobs', jobs: [job] });
  document.querySelector('.job-actions button').click();
  message({ ...state, jobs: [job] });
  assert.equal(model.value, 'large');
  assert.equal(effort.value, 'xhigh');
  assert.match(document.querySelector('.job-model').textContent, /large · Extra High/);
  change(model, '');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).model, null);
  assert.equal(sent.at(-1).reasoningEffort, null);
  dom.window.close();
});

test('catalog failure and removed models do not silently replace edited task settings', () => {
  const { dom, sent, message, document } = setup();
  const job = { id: 'missing', threadMode: 'new', threadId: id, model: 'removed', reasoningEffort: 'xhigh', sendAt: Date.now() + 600000, status: 'scheduled' };
  message({ type: 'jobs', jobs: [job] });
  document.querySelector('.job-actions button').click();
  message({ type: 'state', threads: [], models: [], jobs: [job], modelsError: 'Catalog unavailable' });
  assert.equal(document.getElementById('model').value, 'removed');
  assert.equal(document.getElementById('reasoningEffort').value, 'xhigh');
  assert.equal(document.getElementById('modelsNote').textContent, 'Catalog unavailable');
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).model, 'removed');
  dom.window.close();
});

test('existing conversations hide model choices and never submit a new-thread model selection', () => {
  const { dom, sent, message, document } = setup();
  const fields = document.getElementById('modelFields');
  const model = document.getElementById('model');
  const effort = document.getElementById('reasoningEffort');
  const switchMode = (name) => {
    const radio = document.getElementById(name);
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  assert.equal(fields.hidden, true);
  assert.match(document.getElementById('modelsNote').textContent, /current Codex model and reasoning effort/);
  message({ type: 'state', threads: [{ id, name: 'Thread' }], selectedThreadId: id, sendAtMs: Date.now() + 600000,
    models: [{ id: 'large', name: 'Large', efforts: ['high', 'xhigh'] }] });
  assert.equal(model.disabled, true);
  assert.equal(effort.disabled, true);
  switchMode('newMode');
  assert.equal(fields.hidden, false);
  assert.equal(model.disabled, false);
  model.value = 'large';
  model.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  effort.value = 'xhigh';
  switchMode('existingMode');
  assert.equal(fields.hidden, true);
  assert.equal(model.disabled, true);
  assert.equal(effort.disabled, true);
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).model, null);
  assert.equal(sent.at(-1).reasoningEffort, null);
  message({ type: 'saved' });
  switchMode('newMode');
  assert.equal(model.value, 'large');
  assert.equal(effort.value, 'xhigh');
  dom.window.close();
});

test('editing a legacy existing-thread task saves conversation defaults even when catalog loading fails', () => {
  const { dom, sent, message, document } = setup();
  const job = { id: 'legacy', threadMode: 'existing', threadId: id, model: 'large', reasoningEffort: 'xhigh',
    sendAt: Date.now() + 600000, status: 'paused', prompt: 'Continue' };
  message({ type: 'jobs', jobs: [job] });
  document.querySelector('.job-actions button').click();
  message({ type: 'state', threads: [], models: [], jobs: [job], modelsError: 'Catalog unavailable' });
  assert.equal(document.getElementById('modelFields').hidden, true);
  assert.match(document.getElementById('modelsNote').textContent, /current Codex model and reasoning effort/);
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).jobId, job.id);
  assert.equal(sent.at(-1).threadId, id);
  assert.equal(sent.at(-1).model, null);
  assert.equal(sent.at(-1).reasoningEffort, null);
  dom.window.close();
});

test('send modes toggle time fields, retain user input, and restore waiting tasks for editing', () => {
  const { dom, sent, message, document } = setup();
  message({ type: 'state', threads: [{ id, name: 'Thread' }], selectedThreadId: id, sendAtMs: new Date(2099, 0, 12, 14, 5).getTime() });
  const available = document.getElementById('whenAvailable');
  available.checked = true;
  available.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('timedFields').hidden, true);
  assert.equal(document.getElementById('waitingFields').hidden, false);
  document.getElementById('waitDays').value = '9';
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).sendMode, 'available');
  assert.equal(sent.at(-1).waitDays, '9');
  message({ type: 'saved' });
  assert.equal(available.checked, true);
  const atTime = document.getElementById('atTime');
  atTime.checked = true;
  atTime.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('timedFields').hidden, false);
  assert.equal(document.getElementById('date').value, '2099/01/12');
  const job = { id: 'wait', threadId: id, sendMode: 'available', waitDays: 8, sendAt: Date.now(),
    expiresAt: Date.now() + 86400000, nextCheckAt: Date.now() + 60000, status: 'scheduled', waitReason: 'weekly' };
  message({ type: 'jobs', jobs: [job] });
  assert.match(document.querySelector('.job-waiting').textContent, /weekly limit/);
  assert.match(document.querySelector('.job-waiting').textContent, /Next check/);
  document.querySelector('.job-actions button').click();
  assert.equal(available.checked, true);
  assert.equal(document.getElementById('waitDays').value, '8');
  assert.match(document.getElementById('waitDeadline').textContent, /Wait until/);
  dom.window.close();
});

test('prompt defaults, explicit policies and reusable templates stay consistent', () => {
  const { dom, sent, message, document } = setup();
  const prompt = document.getElementById('prompt');
  const policy = document.getElementById('stalePolicy');
  const picker = document.getElementById('promptTemplate');
  const change = (element, type = 'change') => element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  message({ type: 'state', threads: [{ id, name: 'Thread' }], sendAtMs: Date.now() + 600000 });
  assert.equal(policy.value, 'skip');
  prompt.value = 'Продолжай с места, где остановился.'; change(prompt, 'input');
  assert.equal(policy.value, 'skip');
  prompt.value = 'Review the current work'; change(prompt, 'input');
  assert.equal(policy.value, 'send');
  policy.value = 'confirm'; change(policy);
  prompt.value = 'Review all changes'; change(prompt, 'input');
  assert.equal(policy.value, 'confirm');
  document.getElementById('saveTemplate').click();
  assert.equal(sent.at(-1).type, 'saveTemplate');
  assert.equal(sent.at(-1).stalePolicy, 'confirm');
  const template = { id: 'custom-review', name: 'My review', prompt: 'Review all changes', stalePolicy: 'confirm' };
  message({ type: 'templates', templates: [{ id: 'continue', name: 'Continue', prompt: 'Continue from where you left off.', stalePolicy: 'skip', builtin: true }, template] });
  picker.value = template.id; change(picker);
  assert.equal(prompt.value, template.prompt);
  assert.equal(policy.value, 'confirm');
  document.getElementById('deleteTemplate').click();
  assert.equal(sent.at(-1).templateId, template.id);
  picker.value = 'continue'; change(picker);
  assert.equal(policy.value, 'skip');
  assert.equal(document.getElementById('deleteTemplate').disabled, true);
  const newMode = document.getElementById('newMode'); newMode.checked = true; change(newMode);
  assert.equal(document.getElementById('staleFields').hidden, true);
  document.getElementById('schedule').click();
  assert.equal(sent.at(-1).stalePolicy, 'send');
  dom.window.close();
});

test('persistent confirmation cards expose Send once and Skip with the matching confirmation ID', () => {
  const { dom, sent, message, document } = setup();
  const job = { id: 'confirmation-job', confirmationId: 'decision-1', status: 'confirmation', threadId: id,
    prompt: 'Continue', sendAt: Date.now(), stalePolicy: 'confirm', waitReason: 'changed' };
  message({ type: 'jobs', jobs: [job] });
  assert.match(document.getElementById('jobList').textContent, /Awaiting confirmation/);
  const buttons = document.querySelectorAll('.job-actions button');
  assert.equal(buttons[0].textContent, 'Send once');
  buttons[0].click();
  assert.equal(sent.at(-1).type, 'staleDecision');
  assert.equal(sent.at(-1).decision, 'send');
  assert.equal(sent.at(-1).confirmationId, job.confirmationId);
  buttons[1].click();
  assert.equal(sent.at(-1).decision, 'skip');
  dom.window.close();
});

test('history retains completed task IDs and exposes open, refresh, and clear actions', () => {
  const { dom, sent, message, document } = setup();
  const completed = { id: 'completed-new', threadMode: 'new', threadId: id, status: 'completed',
    prompt: 'Run in a fresh conversation', sendAt: Date.now(), archivedAt: Date.now(), acceptedAt: Date.now(), finishedAt: Date.now() };
  message({ type: 'jobs', jobs: [], history: [completed] });
  assert.match(document.getElementById('jobList').textContent, /No scheduled tasks/);
  assert.match(document.getElementById('historyList').textContent, /Completed/);
  assert.match(document.getElementById('historyList').textContent, new RegExp(id));
  assert.doesNotMatch(document.getElementById('historyList').textContent, /Retry|Edit/);
  document.querySelector('#historyList button').click();
  assert.equal(sent.at(-1).type, 'openThread');
  assert.equal(sent.at(-1).jobId, completed.id);
  document.getElementById('refreshHistory').click();
  assert.equal(sent.at(-1).type, 'refreshHistory');
  document.getElementById('clearHistory').click();
  assert.equal(sent.at(-1).type, 'clearHistory');
  message({ type: 'jobs', jobs: [] });
  assert.match(document.getElementById('historyList').textContent, /Completed/);
  message({ type: 'jobs', jobs: [], history: [{ ...completed, status: 'delivered' }] });
  assert.match(document.getElementById('historyList').textContent, /completion has not been confirmed/);
  dom.window.close();
});

test('running new conversations explain why opening waits for completion', () => {
  const { dom, sent, message, document } = setup();
  const job = { id: 'background-new', threadMode: 'new', threadId: id, threadInitialized: true,
    turnId: 'turn', status: 'sending', prompt: 'Background work', sendAt: Date.now() };
  message({ type: 'jobs', jobs: [job], history: [] });
  const card = document.getElementById('jobList');
  assert.match(card.textContent, /Running in the background through Schedex/);
  assert.match(card.textContent, /becomes available when the run finishes/);
  assert.equal(Array.from(card.querySelectorAll('button')).find((button) => button.textContent === 'Open in Codex').disabled, true);
  message({ type: 'jobs', jobs: [], history: [{ ...job, status: 'completed', archivedAt: Date.now() }] });
  const history = document.getElementById('historyList');
  assert.doesNotMatch(history.textContent, /Running in the background/);
  const open = history.querySelector('button');
  assert.equal(open.disabled, false);
  open.click();
  assert.equal(sent.at(-1).jobId, job.id);
  dom.window.close();
});

test('refresh feedback waits for the response and shows last-check seconds without clearing active tasks', () => {
  const { dom, sent, message, document } = setup();
  const lastCheck = new Date(2026, 10, 4, 1, 12, 7).getTime();
  const active = { id: 'active', threadId: id, status: 'scheduled', prompt: 'Active task', sendAt: Date.now() + 600000 };
  const archived = { id: 'old', threadId: id, status: 'interrupted', archivedAt: Date.now(), lastStatusCheckAt: lastCheck };
  message({ type: 'jobs', jobs: [active], history: [archived] });
  assert.match(document.getElementById('historyList').textContent, /Last status check: .*01:12:07/);
  const button = document.getElementById('refreshHistory');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Refreshing…');
  assert.equal(sent.at(-1).type, 'refreshHistory');
  message({ type: 'historyRefreshed', history: [{ ...archived, status: 'completed', lastStatusCheckAt: lastCheck + 1000 }] });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Refresh status');
  assert.match(document.getElementById('historyList').textContent, /Completed/);
  assert.match(document.getElementById('historyList').textContent, /Last status check: .*01:12:08/);
  assert.match(document.getElementById('jobList').textContent, /Active task/);
  dom.window.close();
});
