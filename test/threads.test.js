'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const opened = [];
const notices = [];
let reads = 0;
let readError;
const runtime = {};
let clipboard = '';
const vscode = { env: { language: 'en', uriScheme: 'vscode-insiders',
  clipboard: { readText: async () => clipboard, writeText: async (text) => { clipboard = text; } },
  openExternal: async (uri) => { opened.push(uri); return true; } },
Uri: { parse: (value) => value }, workspace: {},
commands: { getCommands: async () => [], executeCommand: async () => {} },
extensions: { getExtension: () => null },
window: { showInformationMessage: (message) => notices.push(message) } };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (parent?.filename === require.resolve('../src/threads')) {
    if (request === './runtime') return {
      resolveCodexRuntime: async () => runtime,
      appServerRequest: async (actualRuntime, method, params) => {
        assert.equal(actualRuntime, runtime);
        assert.equal(method, 'thread/read');
        assert.deepEqual(params, { threadId: id, includeTurns: false });
        reads++;
        if (readError) throw readError;
        if (reads === 1) throw new Error('no rollout found for thread id ' + id);
        return { thread: { id } };
      }
    };
    if (request === './utils') return { ...originalLoad.call(this, request, parent, isMain), sleep: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { initialize, extractThreadId, openJobThread, resolveCurrentThreadIdNonInteractive, rememberThreadBinding } = require('../src/threads');
Module._load = originalLoad;

const id = '12345678-1234-4234-8234-123456789abc';
test('extracts Codex thread links and rejects unrelated text', () => {
  assert.equal(extractThreadId(`codex://threads/${id}`), id);
  assert.equal(extractThreadId(`vscode://openai.chatgpt/local/${id}`), id);
  assert.equal(extractThreadId(`Codex thread: ${id}`), id);
  assert.equal(extractThreadId(`unrelated ${id}`), null);
  assert.equal(extractThreadId('not-a-uuid'), null);
});

test('an editor invocation uses its conversation while sidebar actions never use a different editor conversation', async () => {
  vscode.window.tabGroups = { activeTabGroup: { activeTab: { input: { uri: `openai-codex://route/local/${id}` } } } };
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), id);
  for (const context of [{ viewId: 'chatgpt.sidebarSecondaryView' }, { webviewId: 'chatgpt.sidebarView' }]) {
    assert.equal(await resolveCurrentThreadIdNonInteractive([context]), null);
  }
  assert.equal(await resolveCurrentThreadIdNonInteractive([{ threadId: id, viewId: 'chatgpt.sidebarView' }]), id);
  vscode.window.tabGroups = undefined;
});

test('old clipboard links and copy commands that do nothing cannot masquerade as the active conversation', async () => {
  clipboard = `codex://threads/${id}`;
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), null);
  vscode.commands.getCommands = async () => ['chatgpt.copyDeeplink'];
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), null);
  assert.equal(clipboard, `codex://threads/${id}`);
  vscode.commands.executeCommand = async () => { clipboard = `codex://threads/${id.replace(/c$/, 'd')}`; };
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), id.replace(/c$/, 'd'));
  assert.equal(clipboard, `codex://threads/${id}`);
  vscode.commands.getCommands = async () => [];
});

test('copying the same link overrides an old explicit binding and restores the original clipboard', async (t) => {
  const bindings = new Map();
  initialize({ globalState: { get: (key, fallback) => bindings.get(key) ?? fallback,
    update: async (key, value) => bindings.set(key, value) } });
  t.after(() => {
    initialize(undefined);
    vscode.commands.getCommands = async () => [];
    vscode.commands.executeCommand = async () => {};
  });
  const currentId = id.replace(/c$/, 'd');
  await rememberThreadBinding(id);
  clipboard = `codex://threads/${currentId}`;
  vscode.commands.getCommands = async () => ['chatgpt.copyDeeplink'];
  vscode.commands.executeCommand = async () => { clipboard = `codex://threads/${currentId}`; };
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), currentId);
  assert.equal(clipboard, `codex://threads/${currentId}`);
  vscode.commands.executeCommand = async () => { clipboard = 'partial'; throw new Error('copy failed'); };
  assert.equal(await resolveCurrentThreadIdNonInteractive([]), id);
  assert.equal(clipboard, `codex://threads/${currentId}`);
});

test('active and provisional new conversations are explained without opening or resuming them', async () => {
  for (const job of [
    { threadMode: 'new', threadId: id, status: 'sending', turnId: 'running-turn', threadInitialized: true },
    { threadMode: 'new', threadId: id, status: 'failed', threadInitialized: false }
  ]) await openJobThread(job);
  assert.equal(opened.length, 0);
  assert.equal(reads, 0);
  assert.match(notices[0], /Running in the background/);
  assert.match(notices[1], /still being prepared/);
});

test('opening a completed new task waits for readable history before dispatching its deep link', async () => {
  reads = 0; opened.length = 0;
  await openJobThread({ threadMode: 'new', threadId: id, status: 'completed', threadInitialized: true });
  assert.equal(reads, 2);
  assert.deepEqual(opened, [`vscode-insiders://openai.chatgpt/local/${id}`]);
});

test('opening retries only missing-rollout errors, with a bound and no premature navigation', async () => {
  for (const error of [new Error('no rollout found for thread id ' + id), new Error('not authenticated')]) {
    reads = 0; opened.length = 0; readError = error;
    await assert.rejects(openJobThread({ threadMode: 'new', threadId: id, status: 'completed' }),
      error.message.startsWith('no rollout') ? /not made this conversation available/ : /not authenticated/);
    assert.equal(reads, error.message.startsWith('no rollout') ? 4 : 1);
    assert.equal(opened.length, 0);
  }
  readError = null;
});

test('existing conversations open directly without taking ownership or checking history', async () => {
  reads = 0; opened.length = 0;
  await openJobThread({ threadMode: 'existing', threadId: id, status: 'sending' });
  assert.equal(reads, 0);
  assert.deepEqual(opened, [`vscode-insiders://openai.chatgpt/local/${id}`]);
});
