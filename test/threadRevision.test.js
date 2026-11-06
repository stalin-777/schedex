'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readThreadRevision } = require('../src/threadRevision');

const turn = () => ({ id: 'turn-1', itemsView: 'full', status: 'completed', items: [
  { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] },
  { id: 'assistant-1', type: 'agentMessage', text: 'Done' }
] });
const revision = (value) => readThreadRevision(async () => ({ data: value ? [value] : [] }), 'thread');

test('new turns, new messages and streaming text updates invalidate the snapshot', async () => {
  const original = await revision(turn());
  for (const update of [
    { ...turn(), id: 'turn-2' },
    { ...turn(), items: [...turn().items, { id: 'user-2', type: 'userMessage', content: [] }] },
    { ...turn(), items: [turn().items[0], { ...turn().items[1], text: 'Done with everything' }] },
    null
  ]) assert.notEqual(await revision(update), original);
});

test('tool output and completion metadata alone do not mark a prompt stale', async () => {
  assert.equal(await revision({ ...turn(), status: 'inProgress', completedAt: null,
    items: [...turn().items, { id: 'tool-1', type: 'commandExecution', output: 'log' }] }), await revision(turn()));
});

test('history is read without resuming and legacy fallback is limited to missing methods', async () => {
  const calls = [];
  const result = await readThreadRevision(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') throw Object.assign(new Error('Unknown method'), { code: -32601 });
    return { thread: { turns: [{ ...turn(), id: 'older' }, turn()] } };
  }, 'thread');
  assert.equal(result, await revision(turn()));
  assert.deepEqual(calls.map((call) => call.method), ['thread/turns/list', 'thread/read']);
  assert.equal(calls[0].params.limit, 1);
  assert.equal(calls[0].params.itemsView, 'full');
  await assert.rejects(readThreadRevision(async () => { throw new Error('Network offline'); }, 'thread'), /offline/);
});

test('missing or partial history cannot produce a usable snapshot', async () => {
  for (const data of [{}, { data: [{ id: 'turn', items: [], itemsView: 'notLoaded' }] }, { data: [{ id: 'turn' }] },
    { data: [{ id: 'turn', items: [{ type: 'agentMessage', text: 'missing identity' }] }] }]) {
    await assert.rejects(readThreadRevision(async () => data, 'thread'));
  }
});
