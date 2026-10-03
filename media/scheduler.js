'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const T = JSON.parse(document.getElementById('i18n').textContent);
  const schedule = document.getElementById('schedule');
  const cancelEdit = document.getElementById('cancelEdit');
  const prompt = document.getElementById('prompt');
  const error = document.getElementById('error');
  const success = document.getElementById('success');
  const sub = document.getElementById('sub');
  let editingJobId = null;
  let saveSequence = 0;
  let pendingSave = null;

  function refreshScheduleEnabled() {
    schedule.disabled = Boolean(pendingSave) || (threadPicker.getMode() === 'existing' && !threadPicker.getSelectedThread());
  }

  function showFeedback(errorText = '', successText = '') {
    error.textContent = errorText;
    success.textContent = successText;
  }

  function acceptSaveResponse(message, allowMissingId = false) {
    if (!pendingSave) return false;
    const requestId = typeof message.requestId === 'string'
      ? message.requestId
      : allowMissingId ? pendingSave.requestId : null;
    if (requestId !== pendingSave.requestId || editingJobId !== pendingSave.jobId) return false;
    pendingSave = null;
    return true;
  }

  const threadPicker = window.SchedexComponents.createThreadPicker(T, refreshScheduleEnabled);
  const dateTimeFields = window.SchedexComponents.createDateTimeFields(T);
  const jobList = window.SchedexComponents.createJobList(T, beginEdit, (jobId) => {
    vscode.postMessage({ type: 'remove', jobId });
  });

  function finishEditing() {
    editingJobId = null;
    pendingSave = null;
    schedule.textContent = T.scheduleButton;
    cancelEdit.hidden = true;
    refreshScheduleEnabled();
  }

  function beginEdit(job) {
    editingJobId = job.id;
    pendingSave = null;
    threadPicker.selectForJob(job);
    dateTimeFields.setJobTime(job.sendAt);
    prompt.value = job.prompt || '';
    schedule.textContent = T.saveChanges;
    cancelEdit.hidden = false;
    showFeedback();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  cancelEdit.addEventListener('click', finishEditing);
  schedule.addEventListener('click', () => {
    schedule.disabled = true;
    showFeedback();
    const selectedThread = threadPicker.getSelectedThread();
    const requestId = `save-${Date.now()}-${++saveSequence}`;
    pendingSave = { requestId, jobId: editingJobId };
    vscode.postMessage({
      type: 'save',
      requestId,
      jobId: editingJobId,
      threadMode: threadPicker.getMode(),
      threadId: selectedThread?.id || '',
      threadName: selectedThread?.name || '',
      ...dateTimeFields.getValue(),
      prompt: prompt.value
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'state') {
      const jobs = Array.isArray(message.jobs) ? message.jobs : [];
      jobList.render(jobs);
      threadPicker.setThreads(Array.isArray(message.threads) ? message.threads : [], message.selectedThreadId);
      if (!prompt.value) prompt.value = message.prompt || T.defaultPrompt;
      dateTimeFields.setSuggestion(message);
      sub.textContent = '';
      refreshScheduleEnabled();
    } else if (message.type === 'loadError') {
      error.textContent = message.error || '';
      sub.textContent = '';
    } else if (message.type === 'validation') {
      if (typeof message.requestId !== 'string') {
        showFeedback(message.error || '');
        if (!pendingSave) refreshScheduleEnabled();
        return;
      }
      if (!acceptSaveResponse(message)) return;
      refreshScheduleEnabled();
      showFeedback(message.error || '');
    } else if (message.type === 'saved') {
      if (!acceptSaveResponse(message, true)) return;
      finishEditing();
      showFeedback('', message.message || '');
    } else if (message.type === 'removed') {
      if (editingJobId === message.jobId) finishEditing();
      showFeedback('', message.message || '');
    } else if (message.type === 'jobs') {
      const jobs = Array.isArray(message.jobs) ? message.jobs : [];
      if (editingJobId && !jobs.some((job) => job.id === editingJobId)) finishEditing();
      jobList.render(jobs);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
