'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readModels, validateModelSettings } = require('../src/models');

test('model catalog follows cursors and keeps model-specific effort capabilities', async () => {
  const cursors = [];
  const models = await readModels(async (method, params) => {
    assert.equal(method, 'model/list');
    cursors.push(params.cursor);
    return params.cursor ? {
      data: [{ model: 'small', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }]
    } : {
      data: [
        { model: 'large', displayName: 'Large', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], defaultReasoningEffort: 'high' },
        { model: 'hidden', hidden: true },
        null
      ], nextCursor: 'page-2'
    };
  });
  assert.deepEqual(cursors, [null, 'page-2']);
  assert.deepEqual(models.map((model) => model.id), ['large', 'small']);
  assert.equal(validateModelSettings(models, 'large', 'xhigh'), null);
  assert.equal(validateModelSettings(models, 'small', 'xhigh'), 'invalidEffort');
  assert.equal(validateModelSettings(models, 'missing', null), 'invalidModel');
  assert.equal(validateModelSettings(models, null, 'high'), 'invalidEffort');
  assert.equal(validateModelSettings([], null, null), null);
});

test('broken model pagination fails rather than silently accepting a partial catalog', async () => {
  await assert.rejects(readModels(async () => ({ data: [], nextCursor: 'same' })), /pagination/);
});
