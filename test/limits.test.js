'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { validatePrompt, MAX_PROMPT_BYTES, MAX_STORE_BYTES } = require('../src/limits');
const { writeJsonAtomic } = require('../src/jobStore');
const { readBoundedLines } = require('../src/boundedLines');

test('prompt limits count UTF-8 bytes, including multibyte text', () => {
  validatePrompt('a'.repeat(MAX_PROMPT_BYTES));
  validatePrompt('😀'.repeat(MAX_PROMPT_BYTES / 4));
  assert.throws(() => validatePrompt('😀'.repeat(MAX_PROMPT_BYTES / 4 + 1)), /64 KiB/);
});

test('an oversized store write leaves the previous atomic file intact', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-size-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'store.json');
  await writeJsonAtomic(file, ['original']);
  await assert.rejects(writeJsonAtomic(file, ['x'.repeat(MAX_STORE_BYTES)]), /16 MiB/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), ['original']);
});

test('bounded line reads preserve UTF-8 across chunks and bound incomplete messages', () => {
  const stream = new PassThrough();
  const lines = [];
  const errors = [];
  readBoundedLines(stream, 12, (line) => lines.push(line), (error) => errors.push(error));
  const text = Buffer.from('Привет\n');
  stream.write(text.subarray(0, 3)); stream.write(text.subarray(3));
  assert.deepEqual(lines, ['Привет']);
  stream.write('a'.repeat(13)); stream.write('ignored\n');
  assert.equal(errors.length, 1);
  assert.deepEqual(lines, ['Привет']);
});
