'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { s } = require('./i18n');
const { formatDateTime, normalizeWhitespace, errorText } = require('./utils');
const { resolveCodexRuntime, getRateLimitSuggestion, getWorkspaceCwdForCodex } = require('./runtime');
const { resolveCurrentThreadIdNonInteractive, listRecentThreads, extractThreadId, getRememberedThreadBinding } = require('./threads');
const { getJobs, upsertJob, updateEditableJob, removeEditableJob, scheduleTimer, notifyChanged } = require('./jobs');
const { schedulerHtml } = require('./schedulerView');
const { parseLocalSendAt } = require('./dateTime');

let extContext;
let schedulerPanel;
let schedulerPanelDispose;
function initialize(context) { extContext = context; }
function dispose() { schedulerPanel = undefined; schedulerPanelDispose?.dispose(); schedulerPanelDispose = undefined; }

async function openScheduler(invocationArgs = []) {
  if (schedulerPanel) {
    schedulerPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }

  schedulerPanel = vscode.window.createWebviewPanel(
    'schedex.schedule',
    'Schedex',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extContext.extensionUri, 'media')]
    }
  );

  const panel = schedulerPanel;
  panel.webview.html = schedulerHtml(panel.webview, extContext.extensionUri);
  schedulerPanelDispose = panel.onDidDispose(() => {
    if (schedulerPanel === panel) schedulerPanel = undefined;
    schedulerPanelDispose?.dispose();
    schedulerPanelDispose = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (panel !== schedulerPanel) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      await hydrateSchedulerPanel(panel, invocationArgs);
      return;
    }
    try {
      if (msg.type === 'save') await handleSaveMessage(panel, msg);
      if (msg.type === 'remove') await handleRemoveMessage(panel, msg);
    } catch (err) {
      await postValidation(panel, s('saveFailed', { error: errorText(err) }), msg.requestId);
    }
  });
}

async function hydrateSchedulerPanel(panel, invocationArgs) {
  if (!panel || panel !== schedulerPanel) return;
  await panel.webview.postMessage({ type: 'jobs', jobs: getJobs() });
  let runtime;
  try {
    runtime = await resolveCodexRuntime();
  } catch (err) {
    await panel.webview.postMessage({ type: 'loadError', error: s('runtimeError', { error: errorText(err) }) });
    return;
  }

  const [threadsResult, activeThreadResult, rateResult] = await Promise.allSettled([
    listRecentThreads(runtime),
    resolveCurrentThreadIdNonInteractive(invocationArgs),
    getRateLimitSuggestion(runtime)
  ]);

  const threads = threadsResult.status === 'fulfilled' ? threadsResult.value : [];
  let activeThreadId = activeThreadResult.status === 'fulfilled' ? activeThreadResult.value : null;
  const rate = rateResult.status === 'fulfilled' ? rateResult.value : null;

  if (!activeThreadId) activeThreadId = getRememberedThreadBinding();
  if (activeThreadId && !threads.some((t) => t.id === activeThreadId)) {
    threads.unshift({ id: activeThreadId, name: s('unnamed'), preview: '', updatedAt: null });
  }
  const sendAtMs = rate?.sendAtMs || (Date.now() + 10 * 60 * 1000);
  const rateNote = rate
    ? s('rateReset', { reset: formatDateTime(rate.resetAtMs) })
    : s('noRateReset');

  await panel.webview.postMessage({
    type: 'state',
    threads,
    jobs: getJobs(),
    selectedThreadId: activeThreadId,
    prompt: s('defaultPrompt'),
    sendAtMs,
    resetSendAtMs: rate?.sendAtMs || null,
    rateNote
  });
}

async function handleSaveMessage(panel, msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const editId = typeof msg.jobId === 'string' ? msg.jobId : null;
  const oldJob = editId ? getJobs().find((job) => job.id === editId) : null;
  if (editId && (!oldJob || !['scheduled', 'failed'].includes(oldJob.status))) {
    return postValidation(panel, s('jobChanged'), requestId);
  }

  const threadMode = msg.threadMode === 'new' ? 'new' : 'existing';
  let threadId = threadMode === 'existing' ? extractThreadId(String(msg.threadId || '')) : null;
  const prompt = String(msg.prompt || '').trim();
  const date = String(msg.date || '').trim();
  const hourText = String(msg.hour ?? '').trim();
  const minuteText = String(msg.minute ?? '').trim();

  if (threadMode === 'existing' && !threadId) return postValidation(panel, s('invalidThread'), requestId);
  if (!prompt) return postValidation(panel, s('invalidPrompt'), requestId);
  const parsed = parseLocalSendAt(date, hourText, minuteText);
  if (parsed.error) return postValidation(panel, s(parsed.error), requestId);
  const sendAt = parsed.sendAt;
  if (sendAt < Date.now() + 1000) return postValidation(panel, s('timePast'), requestId);

  if (threadMode === 'new') {
    threadId = oldJob?.threadMode === 'new' ? oldJob.threadId || null : null;
  }

  const threadName = threadMode === 'new' ? s('newThread') : normalizeWhitespace(msg.threadName || '') || threadId;
  const changes = {
    threadId,
    threadName,
    threadMode,
    prompt,
    sendAt,
    cwd: oldJob && Object.prototype.hasOwnProperty.call(oldJob, 'cwd')
      ? oldJob.cwd
      : getWorkspaceCwdForCodex?.() || null
  };
  const job = editId
    ? await updateEditableJob(editId, changes)
    : { id: crypto.randomUUID(), ...changes, createdAt: Date.now(), attempts: 0, status: 'scheduled', lastError: null };
  if (!job) return postValidation(panel, s('jobChanged'), requestId);
  if (!editId) await upsertJob(job);
  scheduleTimer(job);
  notifyChanged();
  const message = s(editId ? 'updatedJob' : 'scheduled', { time: formatDateTime(sendAt) });
  await panel.webview.postMessage({ type: 'saved', requestId, message });
  vscode.window.showInformationMessage(message);
}

async function handleRemoveMessage(panel, msg) {
  if (typeof msg.jobId !== 'string' || !await removeEditableJob(msg.jobId)) {
    return postValidation(panel, s('jobChanged'));
  }
  notifyChanged();
  await panel.webview.postMessage({ type: 'removed', jobId: msg.jobId, message: s('removed') });
}

function publishJobs() {
  if (schedulerPanel) schedulerPanel.webview.postMessage({ type: 'jobs', jobs: getJobs() }).then(undefined, () => {});
}

function postValidation(panel, error, requestId) {
  return panel.webview.postMessage({ type: 'validation', requestId, error });
}


module.exports = { initialize, openScheduler, publishJobs, dispose };
