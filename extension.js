'use strict';

const vscode = require('vscode');
const { s } = require('./src/i18n');
const { initialize: initializeThreads, bindThreadFromClipboard } = require('./src/threads');
const jobs = require('./src/jobs');
const scheduler = require('./src/scheduler');
const { manageScheduled } = require('./src/manage');
const { diagnoseUi } = require('./src/diagnostics');

let statusBar;
let retentionTimer;

async function activate(context) {
  initializeThreads(context);
  scheduler.initialize(context);
  jobs.initialize(context, () => {
    updateStatusBar();
    scheduler.publishJobs();
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('schedex.schedulePrompt', (...args) => scheduler.openScheduler(args)),
    vscode.commands.registerCommand('schedex.manageScheduled', manageScheduled),
    vscode.commands.registerCommand('schedex.bindThreadFromClipboard', bindThreadFromClipboard),
    vscode.commands.registerCommand('schedex.diagnoseUi', diagnoseUi)
  );
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 75);
  context.subscriptions.push(statusBar);
  const prune = () => jobs.pruneHistory(vscode.workspace?.getConfiguration?.('schedex')?.get('historyRetentionDays', 0) || 0);
  await prune();
  clearInterval(retentionTimer);
  retentionTimer = setInterval(() => prune().catch((error) => console.error('Schedex history retention:', error)), 86400000);
  retentionTimer.unref();
  context.subscriptions.push({ dispose: () => clearInterval(retentionTimer) });
  const settings = vscode.workspace?.onDidChangeConfiguration?.((event) => {
    if (event.affectsConfiguration('schedex.historyRetentionDays')) prune().then(scheduler.publishJobs).catch(console.error);
  });
  if (settings) context.subscriptions.push(settings);
  await jobs.restoreTimers();
  updateStatusBar();
}

function deactivate() {
  clearInterval(retentionTimer);
  jobs.dispose();
  scheduler.dispose();
}

function updateStatusBar() {
  if (!statusBar) return;
  const currentJobs = jobs.getJobs();
  const scheduled = currentJobs.filter((j) => ['scheduled', 'checking', 'sending'].includes(j.status)).length;
  const failed = currentJobs.filter((j) => ['failed', 'paused', 'expired', 'review', 'confirmation'].includes(j.status)).length;
  if (!scheduled && !failed) {
    statusBar.text = '$(schedex-schedule-send) Schedex';
    statusBar.tooltip = s('statusIdle');
    statusBar.command = 'schedex.schedulePrompt';
  } else {
    statusBar.text = failed ? `$(schedex-schedule-send) Schedex: ${scheduled} · $(error) ${failed}` : `$(schedex-schedule-send) Schedex: ${scheduled}`;
    statusBar.tooltip = s('statusJobs');
    statusBar.command = 'schedex.schedulePrompt';
  }
  statusBar.show();
}


module.exports = { activate, deactivate };
