'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'vscode') return { env: { language: 'en' } };
  return originalLoad.call(this, name, ...args);
};
const templates = require('../src/promptTemplates');
const locks = require('../src/jobLocks');
Module._load = originalLoad;

test('continuation prompts default to skipping and arbitrary prompts default to sending', () => {
  for (const prompt of ['Продолжай', '  Continue! ', 'Continue from where you left off.',
    'Продолжай с места, где остановился.', '从上次停下的地方继续。']) {
    assert.equal(templates.defaultStalePolicy(prompt), 'skip');
  }
  assert.equal(templates.defaultStalePolicy('Continue by reviewing the new commit'), 'send');
});

test('custom templates and policies persist across contexts without losing concurrent additions', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-templates-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const context = { globalStorageUri: { fsPath: folder } };
  locks.initialize(context);
  const initial = await templates.listTemplates(context);
  assert.deepEqual(initial.map((item) => item.id), ['continue', 'review', 'test', 'summarize']);
  assert.equal(initial[0].stalePolicy, 'skip');
  await Promise.all([
    templates.saveTemplate(context, { name: 'My review', prompt: 'Review my changes', stalePolicy: 'confirm' }),
    templates.saveTemplate(context, { name: 'My report', prompt: 'Write a report', stalePolicy: 'send' })
  ]);
  const persisted = await templates.listTemplates({ globalStorageUri: { fsPath: folder } });
  assert.equal(persisted.length, 6);
  assert.equal(persisted.find((item) => item.name === 'My review').stalePolicy, 'confirm');
  const report = persisted.find((item) => item.name === 'My report');
  await templates.deleteTemplate(context, report.id);
  await templates.deleteTemplate(context, 'continue');
  const remaining = await templates.listTemplates(context);
  assert.equal(remaining.length, 5);
  assert.equal(remaining.some((item) => item.id === 'continue'), true);
  assert.equal(remaining.some((item) => item.id === report.id), false);
});

test('oversized prompts and excess templates are rejected without modifying existing data', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'schedex-template-limits-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const context = { globalStorageUri: { fsPath: folder } };
  locks.initialize(context);
  const template = { name: 'Extra', prompt: 'Private prompt', stalePolicy: 'send' };
  assert.throws(() => templates.saveTemplate(context, { ...template, prompt: 'x'.repeat(65537) }), /64 KiB/);
  const existing = Array.from({ length: 100 }, (_, i) => ({ ...template, id: 'custom-' + i }));
  const file = path.join(folder, 'prompt-templates.v1.json');
  await fs.writeFile(file, JSON.stringify(existing));
  await assert.rejects(templates.saveTemplate(context, template), /100 custom/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), existing);
});
