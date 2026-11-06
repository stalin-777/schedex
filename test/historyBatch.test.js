'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
let opened = 0;
let closed = 0;
const calls = [];
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'vscode') return {};
  if (name === './appServerClient' && parent?.filename === require.resolve('../src/runtime')) return {
    connectAppServer: async () => {
      opened++;
      return { close() { closed++; }, request: async (method, params) => {
        calls.push({ method, params });
        if (params.threadId === 'missing') throw new Error('Thread unavailable');
        return { data: [1, 2, 3].map((id) => ({ id: 'turn-' + id, status: 'completed', completedAt: 20 })) };
      } };
    }
  };
  return originalLoad.call(this, name, parent, isMain);
};
const { readHistoryProgress } = require('../src/runtime');
Module._load = originalLoad;

test('a history pass shares one read-only client and reuses pages for the same conversation', async () => {
  const jobs = [1, 2, 3].map((id) => ({ id: String(id), threadId: 'shared-thread', turnId: 'turn-' + id }));
  jobs.push({ id: 'other', threadId: 'other-thread', turnId: 'turn-1' }, { id: 'bad', threadId: 'missing', turnId: 'turn' });
  const updates = await readHistoryProgress({}, jobs);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.method === 'thread/turns/list'), true);
  assert.equal(updates.filter((item) => item.changes.status === 'completed').length, 4);
  assert.match(updates.find((item) => item.id === 'bad').changes.statusError, /unavailable/);
  assert.equal(updates.find((item) => item.id === 'bad').changes.status, undefined);
});
