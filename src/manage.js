'use strict';

const vscode = require('vscode');
const { s } = require('./i18n');
const { formatDateTime, truncate } = require('./utils');
const { openScheduler } = require('./scheduler');
const { getJobs, removeEditableJob, updateEditableJob, scheduleTimer, notifyChanged } = require('./jobs');

async function manageScheduled() {
  const jobs = getJobs();
  if (!jobs.length) {
    const action = await vscode.window.showInformationMessage(s('noScheduled'), s('schedule'));
    if (action === s('schedule')) await openScheduler([]);
    return;
  }
  const items = jobs
    .slice()
    .sort((a, b) => a.sendAt - b.sendAt)
    .map((job) => ({
      label: `${job.status === 'failed' ? '$(error)' : job.status === 'sending' ? '$(sync~spin)' : '$(calendar)'} ${formatDateTime(job.sendAt)}`,
      description: job.threadName || job.threadId,
      detail: `${truncate(job.prompt, 140)}${job.lastError ? ` · ${truncate(job.lastError, 100)}` : ''}`,
      job
    }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: s('chooseScheduled') });
  if (!picked) return;
  if (picked.job.status === 'sending') {
    vscode.window.showInformationMessage(s('sending'));
    return;
  }
  const choices = picked.job.status === 'failed' ? [s('retryNow'), s('remove')] : [s('sendNow'), s('cancel')];
  const action = await vscode.window.showQuickPick(choices, { placeHolder: picked.description });
  if (!action) return;
  if (action === s('cancel') || action === s('remove')) {
    if (!await removeEditableJob(picked.job.id)) return;
    notifyChanged();
    vscode.window.showInformationMessage(s('removed'));
    return;
  }
  const job = await updateEditableJob(picked.job.id, { sendAt: Date.now() + 1000 });
  if (!job) return;
  scheduleTimer(job);
  notifyChanged();
}


module.exports = { manageScheduled };
