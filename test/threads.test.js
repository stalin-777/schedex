'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, workspace: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { extractThreadId } = require('../src/threads');
Module._load = originalLoad;

const id = '12345678-1234-4234-8234-123456789abc';
test('extracts Codex thread links and rejects unrelated text', () => {
  assert.equal(extractThreadId(`codex://threads/${id}`), id);
  assert.equal(extractThreadId(`vscode://openai.chatgpt/local/${id}`), id);
  assert.equal(extractThreadId(`Codex thread: ${id}`), id);
  assert.equal(extractThreadId(`unrelated ${id}`), null);
  assert.equal(extractThreadId('not-a-uuid'), null);
});
