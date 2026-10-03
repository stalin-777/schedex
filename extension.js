'use strict';

const vscode = require('vscode');
const { s } = require('./src/i18n');
const { initialize: initializeThreads, bindThreadFromClipboard } = require('./src/threads');
const jobs = require('./src/jobs');
const scheduler = require('./src/scheduler');
const { manageScheduled } = require('./src/manage');
const { diagnoseUi } = require('./src/diagnostics');

let statusBar;

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
  await jobs.restoreTimers();
  updateStatusBar();
}

function deactivate() {
  jobs.dispose();
  scheduler.dispose();
}

function updateStatusBar() {
  if (!statusBar) return;
  const currentJobs = jobs.getJobs();
  const scheduled = currentJobs.filter((j) => j.status === 'scheduled' || j.status === 'sending').length;
  const failed = currentJobs.filter((j) => j.status === 'failed').length;
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
