'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');

function manager(job) {
  const calls = [];
  const filename = require.resolve('../src/manage');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
  mod.require = function(name) {
    if (name === 'vscode') return { window: { showQuickPick: async (items) => items[0] } };
    if (name === './i18n') return { s: (key) => key };
    if (name === './scheduler') return { openScheduler: async (...args) => calls.push(['edit', ...args]) };
    if (name === './threads') return {};
    if (name === './jobs') return {
      getSnapshot: () => ({ jobs: [job], history: [] }),
      requestAvailabilityCheck: async (id) => { calls.push(['check', id]); return job; },
      updateEditableJob: async (id, changes) => { calls.push(['save', id, changes]); return job; },
      scheduleTimer: () => calls.push('timer'), notifyChanged() {}
    };
    return Module.prototype.require.call(this, name);
  };
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { run: mod.exports.manageScheduled, calls };
}

test('Check now uses the dedicated check operation instead of resetting an editable job', async () => {
  const { run, calls } = manager({ id: 'waiting', sendMode: 'available', status: 'scheduled', sendAt: Date.now() });
  await run();
  assert.deepEqual(calls, [['check', 'waiting'], 'timer']);
});

test('paused and expired availability jobs require explicit editing instead of an automatic restart', async () => {
  for (const sendMode of ['time', 'available']) {
    for (const status of ['paused', 'expired', 'review']) {
      const { run, calls } = manager({ id: status, sendMode, status, sendAt: Date.now() });
      await run();
      assert.deepEqual(calls, [['edit', [], status]]);
    }
  }
});

test('fixed-time manual retries retain the explicit rescheduling action', async () => {
  const { run, calls } = manager({ id: 'fixed', sendMode: 'time', status: 'failed', sendAt: 100 });
  const before = Date.now();
  await run();
  assert.equal(calls[0][0], 'save');
  assert.equal(calls[0][1], 'fixed');
  assert.ok(calls[0][2].sendAt >= before + 1000);
});
