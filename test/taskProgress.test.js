'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readTaskProgress } = require('../src/taskProgress');

test('queue entries carry the exact client message identity into progress tracking', async () => {
  const progress = await readTaskProgress(async () => ({ data: [{ id: 'queue-1', clientUserMessageId: 'message-1' }] }),
    { threadId: 'thread', queuedSubmissionId: 'queue-1' });
  assert.equal(progress.status, 'queued');
  assert.equal(progress.clientMessageId, 'message-1');
});

test('only the matching turn or client message can establish running or completed status', async () => {
  const data = [
    { id: 'unrelated', status: 'completed', items: [{ type: 'userMessage', clientId: 'someone-else' }] },
    { id: 'scheduled-turn', status: 'inProgress', startedAt: 10, items: [{ type: 'userMessage', clientId: 'message-1' }] }
  ];
  const request = async (method) => ({ data: method === 'thread/queue/list' ? [] : data });
  const job = { threadId: 'thread', queuedSubmissionId: 'queue-1', clientMessageId: 'message-1' };
  const running = await readTaskProgress(request, job);
  assert.equal(running.status, 'running');
  assert.equal(running.turnId, 'scheduled-turn');
  assert.equal(running.startedAt, 10000);
  data[1].status = 'completed'; data[1].completedAt = 20;
  const completed = await readTaskProgress(request, { ...job, turnId: running.turnId });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finishedAt, 20000);
});

test('a consumed queue entry without a traceable identity never implies completion', async () => {
  const progress = await readTaskProgress(async () => ({ data: [] }), { threadId: 'thread', queuedSubmissionId: 'queue-1' });
  assert.equal(progress.status, 'delivered');
  assert.equal(progress.trackingUnknown, true);
});

test('missing evidence for an uncertain submission preserves Needs review', async () => {
  for (const identity of [{}, { clientMessageId: 'message' }, { turnId: 'turn' }, { queuedSubmissionId: 'queue' }]) {
    const progress = await readTaskProgress(async () => ({ data: [] }), { threadId: 'thread', status: 'review', ...identity });
    assert.equal(progress.status, 'review');
    assert.equal(progress.trackingUnknown, true);
  }
});

test('failed and interrupted turns retain their actual outcome and error', async () => {
  for (const status of ['failed', 'interrupted']) {
    const result = await readTaskProgress(async () => ({ data: [{ id: 'turn', status, error: { message: 'service stopped' } }] }),
      { threadId: 'thread', turnId: 'turn' });
    assert.equal(result.status, status);
    assert.equal(result.lastError, 'service stopped');
  }
});

test('an interrupted projection without terminal evidence stays unconfirmed until actual completion', async () => {
  const turn = { id: 'turn', status: 'interrupted', startedAt: 10, completedAt: null, error: null };
  const job = { threadId: 'thread', turnId: 'turn', finishedAt: 15000 };
  const request = async () => ({ data: [turn] });
  const pending = await readTaskProgress(request, job);
  assert.equal(pending.status, 'delivered');
  assert.equal(pending.trackingUnknown, true);
  assert.equal(pending.terminalStatusConfirmed, false);
  assert.equal(pending.finishedAt, null);
  turn.status = 'completed'; turn.completedAt = 20;
  const completed = await readTaskProgress(request, { ...job, ...pending });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finishedAt, 20000);
  assert.equal(completed.terminalStatusConfirmed, true);
});

test('completion times are never invented and confirmed terminal results survive partial projections', async () => {
  const job = { threadId: 'thread', turnId: 'turn' };
  const completed = await readTaskProgress(async () => ({ data: [{ id: 'turn', status: 'completed' }] }), job);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finishedAt, null);
  const verified = { ...job, status: 'completed', finishedAt: 10000, terminalStatusConfirmed: true };
  const partial = await readTaskProgress(async () => ({ data: [{ id: 'turn', status: 'interrupted' }] }), verified);
  assert.equal(partial.status, 'completed');
  assert.equal(partial.trackingUnknown, false);
});

test('confirmed terminal results survive the 500-turn search limit', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    let pages = 0;
    const job = { threadId: 'thread', turnId: 'old-turn', status, terminalStatusConfirmed: true,
      finishedAt: 20000, lastError: status === 'failed' ? 'original error' : null };
    const progress = await readTaskProgress(async (method) => {
      assert.equal(method, 'thread/turns/list');
      pages++;
      return { data: Array.from({ length: 50 }, (_, i) => ({ id: `recent-${pages}-${i}`, status: 'completed' })),
        nextCursor: 'page-' + pages };
    }, job);
    assert.equal(pages, 10);
    assert.deepEqual({ ...job, ...progress }, { ...job, trackingUnknown: false });
  }
});

test('absent or unknown turn data preserves confirmed results, while unconfirmed deliveries remain unknown', async () => {
  for (const data of [[], [{ id: 'turn', status: 'unknown' }]]) {
    const request = async () => ({ data });
    const job = { threadId: 'thread', turnId: 'turn', status: 'completed', terminalStatusConfirmed: true };
    assert.equal((await readTaskProgress(request, job)).status, 'completed');
    const unconfirmed = await readTaskProgress(request, { ...job, terminalStatusConfirmed: false });
    assert.equal(unconfirmed.status, 'delivered');
    assert.equal(unconfirmed.trackingUnknown, true);
  }
});
