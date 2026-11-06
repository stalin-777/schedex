'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const Module = require('node:module');
const test = require('node:test');

let server;
const clientPath = require.resolve('../src/appServerClient');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'child_process' && parent?.filename === clientPath) return { spawn: (_command, args) => {
    server.spawnArgs = args; return server.child;
  } };
  return originalLoad.call(this, request, parent, isMain);
};
const { connectAppServer } = require('../src/appServerClient');
Module._load = originalLoad;

Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, window: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { deliverDirect } = require('../src/directDelivery');
const { queuePrompt } = require('../src/runtime');
Module._load = originalLoad;

function fakeServer(handler) {
  const received = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const reply = (message) => {
    const line = JSON.stringify(message) + '\n';
    child.stdout.write(line.slice(0, 3));
    child.stdout.write(line.slice(3));
  };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString());
    received.push(message);
    queueMicrotask(() => {
      if (message.method === 'initialize') reply({ id: message.id, result: {} });
      else handler?.(message, reply);
    });
    done();
  } });
  child.kill = () => { child.stdout.end(); child.emit('close', 0); };
  server = { child, received, reply };
  return server;
}

test('RPC separates notifications and server requests from matching response IDs', async () => {
  const host = fakeServer((message, reply) => {
    if (message.method === 'test') {
      host.child.stdout.write('invalid json\nnull\n');
      reply({ id: message.id, method: 'approval', params: {} });
      reply({ method: 'turn/completed', params: { turn: { id: 'turn' } } });
      reply({ id: message.id, result: { ok: true } });
    }
  });
  const approvals = [];
  const client = await connectAppServer({ command: 'codex', baseArgs: [] }, {
    onRequest: async (message) => { approvals.push(message); return { decision: 'decline' }; }
  });
  const notifications = [];
  client.onNotification((message) => notifications.push(message.method));
  assert.deepEqual(await client.request('test', {}), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ['turn/completed']);
  assert.equal(approvals.length, 1);
  assert.equal(host.received.some((message) => message.result?.decision === 'decline'), true);
  assert.equal(host.received[1].method, 'initialized');
  client.close();
});

test('RPC timeouts and disconnects reject pending requests without hanging', async () => {
  fakeServer();
  const client = await connectAppServer({ command: 'codex', baseArgs: [] });
  await assert.rejects(client.request('never', {}, 10), /timeout/);
  const pending = client.request('pending', {});
  client.close(new Error('disconnected'));
  await assert.rejects(pending, /disconnected/);
  assert.equal((await client.whenClosed).message, 'disconnected');
});

test('new-thread delivery does not finish until the owning server process has exited', async () => {
  const threadId = '12345678-1234-4234-8234-123456789abc';
  const host = fakeServer((message, reply) => {
    if (message.method === 'thread/start') reply({ id: message.id,
      result: { thread: { id: threadId, status: { type: 'idle' } } } });
    if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'first-turn' } } });
      reply({ method: 'turn/completed', params: { threadId, turn: { id: 'first-turn', status: 'completed' } } });
    }
  });
  let stopRequested = false;
  host.child.kill = () => { stopRequested = true; };
  let delivered = false;
  const delivery = deliverDirect({ command: 'codex', baseArgs: [] },
    { threadMode: 'new', prompt: 'Background prompt' }, async () => {}, async () => {})
    .then(() => { delivered = true; });
  while (!stopRequested) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false, 'the UI must not offer to open a thread whose writer is still alive');
  host.child.stdout.end(); host.child.emit('close', 0);
  await delivery;
  assert.equal(delivered, true);
});

test('queue RPC sends private text only over stdin and does not resume an externally owned thread', async () => {
  const host = fakeServer((message, reply) => {
    if (message.method === 'thread/queue/add') reply({ id: message.id,
      result: { queuedSubmission: { id: 'queue', clientUserMessageId: message.params.clientUserMessageId } } });
  });
  const prompt = 'Private "work"\n$(do not execute)';
  let checked = false;
  const receipt = await queuePrompt({ command: 'codex', baseArgs: [] },
    { threadId: 'externally-owned-thread', prompt, clientMessageId: 'client-message' }, async () => { checked = true; });
  assert.equal(checked, true);
  assert.equal(receipt.id, 'queue');
  assert.deepEqual(host.spawnArgs, ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(host.received.find((item) => item.method === 'thread/queue/add').params, {
    threadId: 'externally-owned-thread', clientUserMessageId: 'client-message',
    input: [{ type: 'text', text: prompt, text_elements: [] }]
  });
  assert.equal(host.received.some((item) => ['thread/start', 'thread/resume', 'turn/start'].includes(item.method)), false);
});

test('queue RPC distinguishes explicit rejection from uncertain acceptance', async () => {
  for (const code of [-32601, -32603]) {
    fakeServer((message, reply) => {
      if (message.method === 'thread/queue/add') reply({ id: message.id, error: { code, message: 'Queue failed' } });
    });
    await assert.rejects(queuePrompt({ command: 'codex', baseArgs: [] }, { threadId: 'thread', prompt: 'Private' }, async () => {}),
      (error) => code === -32601 ? error.submissionRejected === true : error.submissionAttempted === true);
  }
});

test('an oversized unterminated RPC message closes the client and rejects pending reads', async () => {
  const host = fakeServer();
  const client = await connectAppServer({ command: 'codex', baseArgs: [] });
  const pending = client.request('pending', {});
  host.child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 120));
  await assert.rejects(pending, /exceeds 16 MiB/);
});
