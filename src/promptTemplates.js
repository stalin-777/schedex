'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { acquireFileLock } = require('./jobLocks');
const { writeJsonAtomic } = require('./jobStore');
const { continuationPrompts, s } = require('./i18n');
const { MAX_STORE_BYTES, MAX_TEMPLATES, validatePrompt } = require('./limits');

const STALE_POLICIES = ['send', 'skip', 'confirm'];
function defaultStalePolicy(prompt) {
  const normalize = (text) => text.trim().toLowerCase().replace(/[.!。！]+$/, '');
  return continuationPrompts().some((text) => normalize(text) === normalize(prompt)) ? 'skip' : 'send';
}

function storagePath(context) {
  return path.join(context.globalStorageUri.fsPath, 'prompt-templates.v1.json');
}

async function readCustom(context) {
  if (!context.globalStorageUri?.fsPath) return [];
  try {
    if ((await fs.stat(storagePath(context))).size > MAX_STORE_BYTES) throw new Error('Prompt template store exceeds 16 MiB');
    const templates = JSON.parse(await fs.readFile(storagePath(context), 'utf8'));
    if (!Array.isArray(templates)) throw new Error('Invalid prompt template store');
    return templates.filter((item) => typeof item.id === 'string' && item.id.startsWith('custom-')
      && typeof item.name === 'string' && typeof item.prompt === 'string' && STALE_POLICIES.includes(item.stalePolicy));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function listTemplates(context) {
  const builtins = ['continue', 'review', 'test', 'summarize'].map((id) => ({
    id, name: s('template_' + id), prompt: id === 'continue' ? s('defaultPrompt') : s('templatePrompt_' + id),
    stalePolicy: id === 'continue' ? 'skip' : 'send', builtin: true
  }));
  return [...builtins, ...await readCustom(context)];
}

async function updateTemplates(context, change) {
  const release = await acquireFileLock('prompt-templates', 30000);
  if (!release) throw new Error('Prompt template storage busy');
  try {
    const templates = await readCustom(context);
    change(templates);
    await writeJsonAtomic(storagePath(context), templates);
  } finally { await release(); }
  return listTemplates(context);
}

function saveTemplate(context, { name, prompt, stalePolicy }) {
  if (!name?.trim() || !prompt?.trim() || !STALE_POLICIES.includes(stalePolicy)) throw new Error(s('invalidTemplate'));
  const template = { id: 'custom-' + crypto.randomUUID(), name: name.trim().slice(0, 80), prompt: prompt.trim(), stalePolicy };
  validatePrompt(template.prompt);
  return updateTemplates(context, (templates) => {
    if (templates.length >= MAX_TEMPLATES) throw new Error('At most 100 custom templates can be saved. Remove an unused template first.');
    templates.push(template);
  });
}

function deleteTemplate(context, id) {
  return updateTemplates(context, (templates) => {
    const index = templates.findIndex((template) => template.id === id);
    if (index >= 0) templates.splice(index, 1);
  });
}

module.exports = { STALE_POLICIES, defaultStalePolicy, listTemplates, saveTemplate, deleteTemplate };
