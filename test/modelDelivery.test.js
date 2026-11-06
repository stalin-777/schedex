'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const warnings = [];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, window: {
    showWarningMessage: (message) => warnings.push(message)
  } };
  return originalLoad.call(this, request, parent, isMain);
};
const { runDirectTurn } = require('../src/directDelivery');
Module._load = originalLoad;

const job = { threadId: 'thread-1', prompt: 'Continue', model: 'large', reasoningEffort: 'xhigh' };
function setup(overrides = {}) {
  const calls = [];
  let listener;
  let updates = 0;
  const prior = { model: 'small', reasoningEffort: 'low', thread: { status: { type: 'idle' } },
    collaborationMode: { mode: 'default', settings: { model: 'small', reasoning_effort: 'low', developer_instructions: null } } };
  const client = {
    whenClosed: new Promise(() => {}),
    onNotification: (fn) => { listener = fn; return () => { listener = null; }; },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'model/list') return { data: [
        { model: 'large', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], defaultReasoningEffort: 'high' },
        { model: 'small', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }
      ] };
      if (method === 'thread/read') {
        if (overrides.readError) throw overrides.readError;
        return { thread: { model: 'small', reasoningEffort: 'low' } };
      }
      if (method === 'thread/queue/list') return { data: overrides.queued || [] };
      if (method === 'thread/start') return { ...prior,
        thread: { ...prior.thread, id: '12345678-1234-4234-8234-123456789abc' } };
      if (method === 'thread/resume') {
        if (overrides.resumeError) throw overrides.resumeError;
        return { ...prior, ...overrides.previous };
      }
      if (method === 'thread/settings/update') {
        updates++;
        if (overrides.updateError && updates === overrides.updateError) throw new Error('settings unavailable');
        return {};
      }
      if (method === 'turn/start') {
        if (overrides.startError) throw overrides.startError;
        listener({ method: 'turn/completed', params: { threadId: 'unrelated', turn: { id: 'other', status: 'failed' } } });
        // Completion may arrive before the response to turn/start.
        listener({ method: 'turn/completed', params: { threadId: job.threadId,
          turn: { id: 'turn-1', status: overrides.turnStatus || 'completed', error: { message: 'rate limit' } } } });
        return { turn: { id: 'turn-1' } };
      }
      throw new Error('unexpected method ' + method);
    }
  };
  return { client, calls, prior };
}

test('starts with the chosen model and effort, then restores future-turn settings', async () => {
  const { client, calls, prior } = setup();
  const started = [];
  await runDirectTurn(client, job, async (id) => started.push(id));
  assert.deepEqual(started, ['turn-1']);
  const turn = calls.find((call) => call.method === 'turn/start').params;
  assert.equal(turn.model, 'large');
  assert.equal(turn.effort, 'xhigh');
  assert.equal(turn.collaborationMode.settings.model, 'large');
  assert.equal(turn.collaborationMode.settings.reasoning_effort, 'xhigh');
  assert.deepEqual(calls.find((call) => call.method === 'thread/resume').params, {
    threadId: job.threadId, excludeTurns: true, model: 'small', config: { model_reasoning_effort: 'low' }
  });
  assert.deepEqual(turn.input, [{ type: 'text', text: job.prompt, text_elements: [] }]);
  assert.deepEqual(calls.at(-1), { method: 'thread/settings/update', params: {
    threadId: job.threadId, model: 'small', effort: 'low', collaborationMode: prior.collaborationMode
  } });
});

test('model default uses its advertised effort instead of inheriting an incompatible thread effort', async () => {
  const { client, calls } = setup();
  await runDirectTurn(client, { ...job, reasoningEffort: null }, async () => {});
  assert.equal(calls.find((call) => call.method === 'turn/start').params.effort, 'high');
});

test('busy or externally owned conversations are deferred without submitting a prompt', async () => {
  for (const overrides of [
    { previous: { thread: { status: { type: 'active' } } } },
    { previous: { thread: { status: { type: 'idle' }, canAcceptDirectInput: false } } },
    { resumeError: new Error('thread thread-1 already has an active writer') }
  ]) {
    const { client, calls } = setup(overrides);
    await assert.rejects(runDirectTurn(client, job, async () => {}), { code: 'THREAD_BUSY' });
    assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  }
});

test('a pending queued prompt prevents resuming and starting a competing turn', async () => {
  const { client, calls } = setup({ queued: [{ id: 'queued-1' }] });
  await assert.rejects(runDirectTurn(client, job, async () => {}), { code: 'THREAD_BUSY' });
  assert.equal(calls.some((call) => ['thread/resume', 'turn/start'].includes(call.method)), false);
});

test('unsupported model, effort, or restoration API cannot silently send using defaults', async () => {
  for (const badJob of [{ ...job, model: 'gone' }, { ...job, model: 'small', reasoningEffort: 'xhigh' }]) {
    const { client, calls } = setup();
    await assert.rejects(runDirectTurn(client, badJob, async () => {}));
    assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  }
  const { client, calls } = setup({ updateError: 1 });
  await assert.rejects(runDirectTurn(client, job, async () => {}), /settings unavailable/);
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
});

test('restoration failure after submission warns without treating the prompt as unsent', async () => {
  const { client } = setup({ updateError: 2 });
  await runDirectTurn(client, job, async () => {});
  assert.match(warnings.at(-1), /previous conversation settings could not be restored/);
});

test('errors after submission carry the turn ID so rate-limit text cannot cause duplicate sends', async () => {
  const { client } = setup({ turnStatus: 'failed' });
  await assert.rejects(runDirectTurn(client, job, async () => {}), { message: 'rate limit', turnId: 'turn-1' });
});

test('new conversations stay in one connection and their ID is saved before submitting', async () => {
  const { client, calls } = setup();
  const created = [];
  // The fake server completes existing thread-1; adapt its completion to the newly created ID.
  const listen = client.onNotification;
  client.onNotification = (callback) => listen((message) => callback({ ...message,
    params: { ...message.params, threadId: message.params.threadId === 'thread-1'
      ? '12345678-1234-4234-8234-123456789abc' : message.params.threadId }
  }));
  await runDirectTurn(client, { ...job, threadMode: 'new', threadId: null, cwd: '/project' },
    async () => assert.equal(created.length, 1), async (id) => created.push(id));
  assert.equal(created[0], '12345678-1234-4234-8234-123456789abc');
  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(calls.find((call) => call.method === 'thread/start').params.cwd, '/project');
});

test('ambiguous turn/start failures cannot trigger automatic rate-limit retries', async () => {
  const { client } = setup({ startError: new Error('rate limit while acknowledging') });
  await assert.rejects(runDirectTurn(client, job, async () => {}), { submissionAttempted: true });
});

test('only a provisional new thread can be replaced if its rollout was never created', async () => {
  const { client, calls } = setup({ readError: new Error('no rollout found for thread id provisional') });
  const listen = client.onNotification;
  client.onNotification = (callback) => listen((message) => callback({ ...message,
    params: { ...message.params, threadId: message.params.threadId === 'thread-1'
      ? '12345678-1234-4234-8234-123456789abc' : message.params.threadId }
  }));
  const created = [];
  const provisional = { ...job, threadId: 'provisional', threadMode: 'new', threadInitialized: false };
  await runDirectTurn(client, provisional, async () => {}, async (id) => created.push(id));
  assert.equal(created.length, 1);
  assert.equal(calls.some((call) => call.method === 'thread/start'), true);
  for (const existing of [{ ...provisional, threadInitialized: true }, { ...provisional, threadMode: 'existing' }]) {
    const { client: other, calls: otherCalls } = setup({ readError: new Error('no rollout found') });
    await assert.rejects(runDirectTurn(other, existing, async () => {}, async () => {}), /no rollout/);
    assert.equal(otherCalls.some((call) => call.method === 'thread/start'), false);
  }
});

test('new default tasks submit the first input on the connection that created the unpersisted thread', async () => {
  const { client, calls } = setup();
  const request = client.request;
  const createdId = '12345678-1234-4234-8234-123456789abc';
  let loaded = false;
  let savedId;
  client.request = async (method, params) => {
    if (['model/list', 'thread/settings/update'].includes(method)) throw new Error('default tasks must not override settings');
    if (['thread/read', 'thread/resume', 'thread/queue/add'].includes(method)) throw new Error('no rollout found for thread id');
    if (method === 'turn/start') {
      assert.equal(loaded, true);
      assert.equal(savedId, createdId);
      assert.equal(params.threadId, createdId);
      assert.equal(Object.hasOwn(params, 'model'), false);
      assert.equal(Object.hasOwn(params, 'effort'), false);
      assert.equal(Object.hasOwn(params, 'collaborationMode'), false);
    }
    const response = await request(method, params);
    if (method === 'thread/start') loaded = true;
    return response;
  };
  const listen = client.onNotification;
  client.onNotification = (callback) => listen((message) => callback({ ...message,
    params: { ...message.params, threadId: message.params.threadId === 'thread-1' ? createdId : message.params.threadId }
  }));
  const started = [];
  await runDirectTurn(client, { threadMode: 'new', threadId: null, model: null, prompt: 'Continue', cwd: '/project' },
    async (id) => started.push(id), async (id) => { savedId = id; });
  assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'turn/start']);
  assert.deepEqual(started, ['turn-1']);
});
