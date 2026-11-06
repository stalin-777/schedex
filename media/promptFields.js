'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createPromptFields = function(T, postMessage) {
  const prompt = document.getElementById('prompt');
  const policy = document.getElementById('stalePolicy');
  const fields = document.getElementById('staleFields');
  const templates = document.getElementById('promptTemplate');
  const remove = document.getElementById('deleteTemplate');
  let list = [];
  let threadMode = 'existing';
  let explicitPolicy = false;

  function refresh() {
    if (!explicitPolicy) {
      const normalize = (text) => text.trim().toLowerCase().replace(/[.!。！]+$/, '');
      const continuations = T.continuationPrompts;
      policy.value = continuations.some((text) => normalize(text) === normalize(prompt.value)) ? 'skip' : 'send';
    }
    const matches = (item) => item.prompt === prompt.value && item.stalePolicy === policy.value;
    const selected = list.find((item) => item.id === templates.value && matches(item)) || list.find(matches);
    templates.value = selected?.id || '';
    remove.disabled = !selected || selected.builtin;
  }

  templates.addEventListener('change', () => {
    const template = list.find((item) => item.id === templates.value);
    if (!template) return;
    prompt.value = template.prompt;
    policy.value = template.stalePolicy;
    explicitPolicy = !template.builtin;
    refresh();
  });
  prompt.addEventListener('input', refresh);
  policy.addEventListener('change', () => { explicitPolicy = true; refresh(); });
  document.getElementById('saveTemplate').addEventListener('click', () => {
    postMessage({ type: 'saveTemplate', prompt: prompt.value, stalePolicy: policy.value });
  });
  remove.addEventListener('click', () => postMessage({ type: 'deleteTemplate', templateId: templates.value }));

  return {
    refresh,
    setThreadMode(mode) { threadMode = mode; fields.hidden = mode === 'new'; },
    setTemplates(items) {
      const selectedId = templates.value;
      list = Array.isArray(items) ? items : [];
      templates.textContent = '';
      for (const item of [{ id: '', name: T.customPrompt }, ...list]) {
        const option = document.createElement('option');
        option.value = item.id; option.textContent = item.name;
        templates.appendChild(option);
      }
      templates.value = selectedId;
      refresh();
    },
    selectForJob(job) {
      prompt.value = job.prompt || '';
      explicitPolicy = Boolean(job.stalePolicy);
      policy.value = job.stalePolicy || 'send';
      refresh();
    },
    getValue: () => ({ stalePolicy: threadMode === 'new' ? 'send' : policy.value })
  };
};
