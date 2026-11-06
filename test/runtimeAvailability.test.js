'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const runtimePath = require.resolve('../src/runtime');
let calls;
let configRequests;
let closed = 0;
const originalLoad = Module._load;
Module._load = function(name, parent, isMain) {
  if (name === 'vscode') return { env: { language: 'en' } };
  if (name === './appServerClient' && parent?.filename === runtimePath) return { connectAppServer: async () => ({
    close() { closed++; },
    request: async (method, params) => {
      calls.push(method);
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.test' } };
      if (method === 'thread/read') throw new Error('no rollout found for thread id');
      if (method === 'config/read') {
        configRequests?.push(params);
        return { config: { model: params.cwd === '/project' ? 'project-model' : 'default-model' } };
      }
      throw new Error('Unexpected method ' + method);
    }
  }) };
  return originalLoad.call(this, name, parent, isMain);
};
const { getAvailabilityContext } = require('../src/runtime');
Module._load = originalLoad;

test('a provisional new-thread ID does not trap availability checks in rollout retries', async () => {
  calls = [];
  const result = await getAvailabilityContext({}, { threadMode: 'new', threadId: 'provisional', threadInitialized: false });
  assert.equal(result.model, 'default-model');
  assert.deepEqual(calls, ['account/read', 'thread/read', 'config/read']);
});

test('a missing existing or accepted thread cannot silently fall back to a new conversation', async () => {
  for (const job of [{ threadMode: 'existing', threadId: 'missing', threadInitialized: false },
    { threadMode: 'new', threadId: 'missing', threadInitialized: true }]) {
    calls = [];
    await assert.rejects(getAvailabilityContext({}, job), /no rollout found/);
    assert.equal(calls.includes('config/read'), false);
  }
});

test('availability reads the same project model that new-thread creation will use', async () => {
  for (const thread of [{}, { threadId: 'provisional', threadInitialized: false }]) {
    calls = []; configRequests = [];
    const before = closed;
    const result = await getAvailabilityContext({}, { threadMode: 'new', cwd: '/project', ...thread });
    assert.equal(result.model, 'project-model');
    assert.deepEqual(configRequests, [{ includeLayers: false, cwd: '/project' }]);
    assert.equal(closed, before + 1);
  }
});

test('failed availability reads still close their app-server connection', async () => {
  calls = [];
  const before = closed;
  await assert.rejects(getAvailabilityContext({}, { threadMode: 'existing', threadId: 'missing' }), /no rollout found/);
  assert.equal(closed, before + 1);
});
