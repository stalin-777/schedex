'use strict';

const vscode = require('vscode');
const { s } = require('./i18n');
const { formatDateTime, truncate } = require('./utils');
const { openScheduler } = require('./scheduler');
const { getSnapshot, refreshHistory, removeEditableJob, updateEditableJob, requestAvailabilityCheck, scheduleTimer, notifyChanged, resolveStaleJob } = require('./jobs');
const { openJobThread } = require('./threads');

async function manageScheduled() {
  const snapshot = getSnapshot();
  const jobs = [...snapshot.jobs, ...snapshot.history];
  if (!jobs.length) {
    const action = await vscode.window.showInformationMessage(s('noScheduled'), s('schedule'));
    if (action === s('schedule')) await openScheduler([]);
    return;
  }
  const items = jobs
    .slice()
    .sort((a, b) => a.sendAt - b.sendAt)
    .map((job) => ({
      label: `${['failed', 'review', 'paused', 'expired'].includes(job.status) ? '$(error)' : ['checking', 'sending'].includes(job.status) ? '$(sync~spin)' : '$(calendar)'} ${job.sendMode === 'available' ? s('sendWhenAvailable') : formatDateTime(job.sendAt)}`,
      description: `${job.archivedAt ? s('status' + job.status[0].toUpperCase() + job.status.slice(1)) + ' · ' : ''}${job.threadName || job.threadId || ''}`,
      detail: `${truncate(job.prompt, 140)}${job.waitReason ? ` · ${s('wait_' + job.waitReason)}` : ''}${job.lastError ? ` · ${truncate(job.lastError, 100)}` : ''}`,
      job
    }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: s('chooseScheduled') });
  if (!picked) return;
  if (picked.job.archivedAt) {
    const options = [s('refreshHistory')];
    if (picked.job.threadId) options.unshift(s('openInCodex'));
    const action = await vscode.window.showQuickPick(options, { placeHolder: picked.description });
    if (action === s('openInCodex')) await openJobThread(picked.job);
    if (action === s('refreshHistory')) await refreshHistory();
    return;
  }
  if (['checking', 'sending'].includes(picked.job.status)) {
    vscode.window.showInformationMessage(s(picked.job.threadMode === 'new' ? 'newThreadRunning' : 'sending'));
    return;
  }
  if (picked.job.status === 'confirmation') {
    const answer = await vscode.window.showQuickPick([s('sendOnce'), s('skipSend')], { placeHolder: s('conversationChanged') });
    if (answer) await resolveStaleJob(picked.job.id, picked.job.confirmationId, answer === s('sendOnce') ? 'send' : 'skip');
    return;
  }
  const needsEdit = ['paused', 'expired', 'review'].includes(picked.job.status)
    || (picked.job.sendMode === 'available' && picked.job.status !== 'scheduled');
  const removeLabel = s(picked.job.status === 'review' ? 'moveToHistory' : 'remove');
  const choices = [s(needsEdit ? 'editJob' : picked.job.sendMode === 'available' ? 'checkNow'
    : picked.job.status === 'scheduled' ? 'sendNow' : 'retryNow'), removeLabel];
  const action = await vscode.window.showQuickPick(choices, { placeHolder: picked.description });
  if (!action) return;
  if (action === s('cancel') || action === removeLabel) {
    if (!await removeEditableJob(picked.job.id)) return;
    notifyChanged();
    vscode.window.showInformationMessage(s('removed'));
    return;
  }
  if (needsEdit) {
    await openScheduler([], picked.job.id);
    return;
  }
  const job = picked.job.sendMode === 'available' ? await requestAvailabilityCheck(picked.job.id)
    : await updateEditableJob(picked.job.id, { sendAt: Date.now() + 1000 });
  if (!job) return;
  scheduleTimer(job);
  notifyChanged();
}


module.exports = { manageScheduled };
