'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const registered = new Map();
const statusBar = { show() { this.visible = true; }, dispose() {} };
const vscode = {
  env: { language: 'en' },
  StatusBarAlignment: { Right: 2 },
  commands: { registerCommand(id, handler) { registered.set(id, handler); return { dispose() {} }; } },
  window: { createStatusBarItem() { return statusBar; } },
  workspace: {}
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const extension = require('../extension');
Module._load = originalLoad;

test('activation registers commands and restores the status item', async () => {
  const context = { subscriptions: [], globalState: { get: (_key, fallback) => fallback, update: async () => {} } };
  await extension.activate(context);
  assert.deepEqual([...registered.keys()], [
    'schedex.schedulePrompt', 'schedex.manageScheduled',
    'schedex.bindThreadFromClipboard', 'schedex.diagnoseUi'
  ]);
  assert.equal(statusBar.visible, true);
  assert.match(statusBar.text, /^\$\(schedex-schedule-send\) Schedex/);
  assert.equal(statusBar.command, 'schedex.schedulePrompt');
  assert.equal(context.subscriptions.length, 5);
  extension.deactivate();
});
