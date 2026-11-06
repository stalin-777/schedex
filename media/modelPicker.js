'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createModelPicker = function(T) {
  const model = document.getElementById('model');
  const effort = document.getElementById('reasoningEffort');
  const note = document.getElementById('modelsNote');
  const fields = document.getElementById('modelFields');
  let threadMode = 'existing';
  let models = [];
  let loading = true;
  let loadError = '';

  function updateNote() {
    note.textContent = threadMode !== 'new' ? T.existingThreadModelHelp
      : loadError || (loading ? T.modelsLoading : T.modelHelp);
  }

  function option(select, value, label) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    select.appendChild(item);
  }

  function effortLabel(value) {
    return T['effort_' + value] || value;
  }

  function renderEfforts(selected = '') {
    effort.textContent = '';
    option(effort, '', model.value ? T.modelDefault : T.codexDefault);
    const current = models.find((item) => item.id === model.value);
    for (const value of current?.efforts || []) option(effort, value, effortLabel(value));
    if (selected && !Array.from(effort.options).some((item) => item.value === selected)) {
      option(effort, selected, `${effortLabel(selected)} (${T.unavailable})`);
    }
    effort.value = selected;
    effort.disabled = threadMode !== 'new' || !model.value;
  }

  function render(selectedModel, selectedEffort) {
    model.textContent = '';
    option(model, '', T.codexDefault);
    for (const item of models) option(model, item.id, item.name);
    if (selectedModel && !models.some((item) => item.id === selectedModel)) {
      option(model, selectedModel, `${selectedModel} (${T.unavailable})`);
    }
    model.value = selectedModel;
    model.disabled = threadMode !== 'new' || (!models.length && !selectedModel);
    fields.hidden = threadMode !== 'new';
    renderEfforts(selectedEffort);
    updateNote();
  }

  function setModels(list, error = '') {
    models = Array.isArray(list) ? list : [];
    loading = false;
    loadError = error;
    render(model.value, effort.value);
  }

  model.addEventListener('change', () => { renderEfforts(); updateNote(); });
  render('', '');
  return {
    setModels,
    setThreadMode(mode) {
      if (threadMode === mode) return;
      threadMode = mode;
      render(model.value, effort.value);
    },
    selectForJob: (job) => render(job.threadMode === 'new' ? job.model || '' : '',
      job.threadMode === 'new' ? job.reasoningEffort || '' : ''),
    getValue: () => ({ model: threadMode === 'new' ? model.value || null : null,
      reasoningEffort: threadMode === 'new' && model.value ? effort.value || null : null })
  };
};
