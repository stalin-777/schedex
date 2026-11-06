'use strict';

async function readModels(request) {
  const models = [];
  const seen = new Set();
  let cursor = null;
  do {
    const result = await request('model/list', { limit: 100, includeHidden: false, cursor });
    if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid model catalog');
    for (const item of result.data) {
      if (!item || item.hidden || typeof item.model !== 'string' || !item.model) continue;
      const efforts = (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
        .map((option) => option?.reasoningEffort).filter((effort) => typeof effort === 'string' && effort);
      models.push({ id: item.model, name: item.displayName || item.model,
        efforts: [...new Set(efforts)], defaultEffort: item.defaultReasoningEffort || null, isDefault: item.isDefault === true });
    }
    cursor = result.nextCursor || null;
    if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('Codex model pagination did not finish');
    seen.add(cursor);
  } while (cursor);
  return models;
}

function validateModelSettings(models, model, reasoningEffort) {
  if (!model) return reasoningEffort ? 'invalidEffort' : null;
  const selected = models.find((item) => item.id === model);
  if (!selected) return 'invalidModel';
  if (reasoningEffort && !selected.efforts.includes(reasoningEffort)) return 'invalidEffort';
  return null;
}

module.exports = { readModels, validateModelSettings };
