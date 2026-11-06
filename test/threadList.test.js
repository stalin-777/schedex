'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const threadsPath = require.resolve('../src/threads');

const calls = [];
let connections = 0;
let closes = 0;
const id1 = '12345678-1234-4234-8234-123456789abc';
const id2 = '12345678-1234-4234-8234-123456789abd';
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, workspace: {} };
  if (request === './runtime' && parent?.filename === threadsPath) return {
    withAppServer: async (_runtime, callback) => {
      connections++;
      try { return await callback({ request: async (method, params) => {
      calls.push({ method, params });
      return params.cursor
        ? { data: [{ id: id2, name: 'Other project' }], nextCursor: null }
        : { data: [{ id: id1, name: 'Current project' }], nextCursor: 'next-page' };
      } }); }
      finally { closes++; }
    }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { listRecentThreads } = require('../src/threads');
Module._load = originalLoad;

test('lists Codex threads across workspaces and follows the next page', async () => {
  const pages = [];
  const threads = await listRecentThreads({}, (items) => {
    pages.push(items);
    assert.equal(calls.length, pages.length, 'publish each page before fetching the next');
  });
  assert.deepEqual(threads.map((thread) => thread.id), [id1, id2]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'thread/list');
  assert.equal(calls[0].params.cwd, undefined);
  assert.deepEqual(calls[0].params.sourceKinds, ['vscode']);
  assert.equal(calls[1].params.cursor, 'next-page');
  assert.deepEqual(pages.map((items) => items.map((item) => item.id)), [[id1], [id1, id2]]);
  assert.equal(connections, 1);
  assert.equal(closes, 1);
});
