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
    modelPicker.setThreadMode(threadPicker.getMode());
    promptFields.setThreadMode(threadPicker.getMode());
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

  const modelPicker = window.SchedexComponents.createModelPicker(T);
  const promptFields = window.SchedexComponents.createPromptFields(T, (message) => vscode.postMessage(message));
  const threadPicker = window.SchedexComponents.createThreadPicker(T, refreshScheduleEnabled);
  const dateTimeFields = window.SchedexComponents.createDateTimeFields(T);
  const sendModePicker = window.SchedexComponents.createSendModePicker(T);
  const jobList = window.SchedexComponents.createJobList(T, beginEdit, (jobId) => {
    vscode.postMessage({ type: 'remove', jobId });
  }, (job, decision) => {
    vscode.postMessage({ type: 'staleDecision', jobId: job.id, confirmationId: job.confirmationId, decision });
  }, (job) => {
    vscode.postMessage({ type: 'openThread', jobId: job.id });
  }, (page) => vscode.postMessage({ type: 'historyPage', page }));
  const refreshHistory = document.getElementById('refreshHistory');
  refreshHistory.addEventListener('click', () => {
    refreshHistory.disabled = true;
    refreshHistory.textContent = T.refreshingHistory;
    vscode.postMessage({ type: 'refreshHistory' });
  });
  document.getElementById('clearHistory').addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));

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
    modelPicker.selectForJob(job);
    sendModePicker.selectForJob(job);
    promptFields.selectForJob(job);
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
      ...modelPicker.getValue(),
      ...sendModePicker.getValue(),
      ...promptFields.getValue(),
      prompt: prompt.value
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'state') {
      const jobs = Array.isArray(message.jobs) ? message.jobs : [];
      jobList.render(jobs, message.history, message);
      if (Array.isArray(message.models)) modelPicker.setModels(message.models, message.modelsError);
      threadPicker.setThreads(message.threads, message.selectedThreadId, message.threadSelectionNote);
      if (!prompt.value) prompt.value = message.prompt || T.defaultPrompt;
      promptFields.refresh();
      dateTimeFields.setSuggestion(message);
      sub.textContent = message.loadingThreads ? T.loadingDetail : '';
      refreshScheduleEnabled();
      if (message.editJob) beginEdit(message.editJob);
      else if (message.editError) showFeedback(message.editError);
    } else if (message.type === 'threads') {
      threadPicker.setThreads(message.threads, message.selectedThreadId);
      sub.textContent = message.loadingThreads ? T.loadingDetail : '';
      refreshScheduleEnabled();
    } else if (message.type === 'selectThread') {
      if (!editingJobId && !pendingSave) threadPicker.selectCurrentThread(message.threadId);
    } else if (message.type === 'models') {
      modelPicker.setModels(message.models, message.modelsError);
    } else if (message.type === 'rateSuggestion') {
      dateTimeFields.setSuggestion(message);
    } else if (message.type === 'editJob') {
      if (message.job) beginEdit(message.job);
    } else if (message.type === 'historyRefreshed') {
      refreshHistory.disabled = false;
      refreshHistory.textContent = T.refreshHistory;
      jobList.setHistory(message.history, message);
    } else if (message.type === 'templates') {
      promptFields.setTemplates(message.templates);
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
      jobList.render(jobs, message.history, message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
