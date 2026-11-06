'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { s } = require('./i18n');
const { formatDateTime, normalizeWhitespace, errorText } = require('./utils');
const { resolveCodexRuntime, getAccountKey, getRateLimitSuggestion, getWorkspaceCwdForCodex, getAvailableModels, getThreadRevision } = require('./runtime');
const { validateModelSettings } = require('./models');
const { resolveCurrentThreadIdNonInteractive, listRecentThreads, extractThreadId, openJobThread } = require('./threads');
const { getJobs, getSnapshot, refreshHistory, clearFinishedHistory, upsertJob, updateEditableJob, removeEditableJob, scheduleTimer, notifyChanged, resolveStaleJob } = require('./jobs');
const { isEditable } = require('./jobStore');
const { STALE_POLICIES, defaultStalePolicy, listTemplates, saveTemplate, deleteTemplate } = require('./promptTemplates');
const { schedulerHtml } = require('./schedulerView');
const { parseLocalSendAt } = require('./dateTime');
const { DAY, DEFAULT_WAIT_DAYS } = require('./availabilityPolicy');
const { validatePrompt } = require('./limits');

let extContext;
let schedulerPanel;
let schedulerPanelDispose;
let availableModels = [];
let schedulerReady = false;
let requestedEditJobId = null;
let requestedThreadId = null;
let historyPage = 0;
function initialize(context) { extContext = context; }
function dispose() {
  schedulerPanel = undefined;
  schedulerReady = false;
  requestedEditJobId = null;
  requestedThreadId = null;
  schedulerPanelDispose?.dispose();
  schedulerPanelDispose = undefined;
}

async function openScheduler(invocationArgs = [], jobId = null) {
  // Opening or revealing the webview changes the active editor and Codex's focus.
  const activeThreadId = jobId ? null : await resolveCurrentThreadIdNonInteractive(invocationArgs).catch(() => null);
  if (schedulerPanel) {
    schedulerPanel.reveal(vscode.ViewColumn.Active, false);
    if (typeof jobId === 'string') {
      requestedEditJobId = jobId;
      requestedThreadId = null;
    } else if (activeThreadId) requestedThreadId = activeThreadId;
    if (schedulerReady) {
      await openRequestedEdit(schedulerPanel);
      await openRequestedThread(schedulerPanel);
    }
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
  availableModels = [];
  schedulerReady = false;
  requestedEditJobId = jobId;
  requestedThreadId = null;
  historyPage = 0;
  panel.webview.html = schedulerHtml(panel.webview, extContext.extensionUri);
  schedulerPanelDispose = panel.onDidDispose(() => {
    if (schedulerPanel === panel) {
      schedulerPanel = undefined;
      schedulerReady = false;
      requestedEditJobId = null;
      requestedThreadId = null;
    }
    schedulerPanelDispose?.dispose();
    schedulerPanelDispose = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (panel !== schedulerPanel) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      await hydrateSchedulerPanel(panel, activeThreadId);
      return;
    }
    try {
      if (msg.type === 'save') await handleSaveMessage(panel, msg);
      if (msg.type === 'remove') await handleRemoveMessage(panel, msg);
      if (msg.type === 'staleDecision') await resolveStaleJob(msg.jobId, msg.confirmationId, msg.decision);
      if (msg.type === 'refreshHistory') {
        try { await refreshHistory(); }
        finally { await panel.webview.postMessage({ type: 'historyRefreshed', ...getSnapshot(historyPage) }); }
      }
      if (msg.type === 'historyPage' && Number.isInteger(msg.page) && msg.page >= 0) {
        historyPage = msg.page;
        publishJobs();
      }
      if (msg.type === 'clearHistory') await clearFinishedHistory();
      if (msg.type === 'openThread') {
        const snapshot = getSnapshot(historyPage);
        const job = [...snapshot.jobs, ...snapshot.history].find((item) => item.id === msg.jobId);
        if (job?.threadId) await openJobThread(job);
      }
      if (msg.type === 'saveTemplate') {
        const name = await vscode.window.showInputBox({ prompt: s('templateName'), placeHolder: s('templateNameHint') });
        if (name?.trim()) await panel.webview.postMessage({ type: 'templates',
          templates: await saveTemplate(extContext, { name, prompt: String(msg.prompt || ''), stalePolicy: msg.stalePolicy }) });
      }
      if (msg.type === 'deleteTemplate' && typeof msg.templateId === 'string') {
        await panel.webview.postMessage({ type: 'templates', templates: await deleteTemplate(extContext, msg.templateId) });
      }
    } catch (err) {
      await postValidation(panel, s('saveFailed', { error: errorText(err) }), msg.requestId);
    }
  });
}

async function openRequestedThread(panel) {
  if (!requestedThreadId) return;
  const threadId = requestedThreadId;
  requestedThreadId = null;
  await panel.webview.postMessage({ type: 'selectThread', threadId });
}

async function openRequestedEdit(panel) {
  const { editJob, editError } = takeRequestedEdit();
  if (editError) return postValidation(panel, editError);
  if (editJob) await panel.webview.postMessage({ type: 'editJob', job: editJob });
}

function takeRequestedEdit() {
  if (!requestedEditJobId) return {};
  const jobId = requestedEditJobId;
  requestedEditJobId = null;
  const job = getJobs().find((item) => item.id === jobId);
  return job && isEditable(job) ? { editJob: job } : { editError: s('jobChanged') };
}

async function hydrateSchedulerPanel(panel, activeThreadId) {
  if (!panel || panel !== schedulerPanel) return;
  activeThreadId = requestedThreadId || activeThreadId;
  requestedThreadId = null;
  const post = (message) => panel === schedulerPanel ? panel.webview.postMessage(message) : false;
  const withActiveThread = (threads) => activeThreadId && !threads.some((thread) => thread.id === activeThreadId)
    ? [{ id: activeThreadId, name: activeThreadId, preview: '' }, ...threads] : threads;
  schedulerReady = true;
  await post({ type: 'state', ...takeRequestedEdit(), threads: withActiveThread([]), selectedThreadId: activeThreadId,
    threadSelectionNote: activeThreadId ? '' : s('activeThreadUnavailable'), loadingThreads: true,
    ...getSnapshot(historyPage), prompt: s('defaultPrompt'), sendAtMs: Date.now() + 10 * 60 * 1000 });
  const templates = listTemplates(extContext)
    .then((templates) => post({ type: 'templates', templates }))
    .catch((error) => post({ type: 'validation', error: s('templatesFailed', { error: errorText(error) }) }));
  let runtime;
  try {
    runtime = await resolveCodexRuntime();
  } catch (err) {
    await post({ type: 'loadError', error: s('runtimeError', { error: errorText(err) }) });
    await templates;
    return;
  }

  const postThreads = (threads, loadingThreads) => post({ type: 'threads', threads: withActiveThread(threads),
    selectedThreadId: activeThreadId, loadingThreads });
  await Promise.all([
    templates,
    listRecentThreads(runtime, (threads) => postThreads(threads, true))
      .then((threads) => postThreads(threads, false))
      .catch((error) => post({ type: 'loadError', error: s('threadsFailed', { error: errorText(error) }) })),
    getRateLimitSuggestion(runtime).catch(() => null).then((rate) => post({ type: 'rateSuggestion',
      sendAtMs: rate?.sendAtMs || Date.now() + 10 * 60 * 1000, resetSendAtMs: rate?.sendAtMs || null,
      rateNote: rate ? s('rateReset', { reset: formatDateTime(rate.resetAtMs) }) : s('noRateReset') })),
    getAvailableModels(runtime).then((models) => {
      if (panel !== schedulerPanel) return;
      availableModels = models;
      return post({ type: 'models', models });
    }).catch(() => post({ type: 'models', models: [], modelsError: s('modelsUnavailable') }))
  ]);
}

async function handleSaveMessage(panel, msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const editId = typeof msg.jobId === 'string' ? msg.jobId : null;
  const oldJob = editId ? getJobs().find((job) => job.id === editId) : null;
  if (editId && (!oldJob || !isEditable(oldJob))) {
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
  try { validatePrompt(prompt); }
  catch (error) { return postValidation(panel, error.message, requestId); }
  if (msg.sendMode != null && !['time', 'available'].includes(msg.sendMode)) return postValidation(panel, s('invalidSendMode'), requestId);
  const sendMode = msg.sendMode === 'available' ? 'available' : 'time';
  const waitDays = Number(msg.waitDays ?? DEFAULT_WAIT_DAYS);
  let sendAt = oldJob?.sendMode === 'available' ? oldJob.sendAt : Date.now();
  let expiresAt = null;
  if (sendMode === 'available') {
    if (!Number.isInteger(waitDays) || waitDays < 1 || waitDays > 30) return postValidation(panel, s('invalidWaitDays'), requestId);
    expiresAt = oldJob?.sendMode === 'available' && oldJob.waitDays === waitDays && oldJob.expiresAt > Date.now()
      ? oldJob.expiresAt : Date.now() + waitDays * DAY;
  } else {
    const parsed = parseLocalSendAt(date, hourText, minuteText);
    if (parsed.error) return postValidation(panel, s(parsed.error), requestId);
    sendAt = parsed.sendAt;
    if (sendAt < Date.now() + 1000) return postValidation(panel, s('timePast'), requestId);
  }

  const model = typeof msg.model === 'string' ? msg.model.trim() || null : null;
  const reasoningEffort = typeof msg.reasoningEffort === 'string' ? msg.reasoningEffort.trim() || null : null;
  if (msg.model != null && typeof msg.model !== 'string') return postValidation(panel, s('invalidModel'), requestId);
  if (msg.reasoningEffort != null && typeof msg.reasoningEffort !== 'string') return postValidation(panel, s('invalidEffort'), requestId);
  if (threadMode === 'existing' && (model || reasoningEffort)) {
    return postValidation(panel, s('existingThreadModelHelp'), requestId);
  }
  const modelError = validateModelSettings(availableModels, model, reasoningEffort);
  if (modelError) return postValidation(panel, s(modelError), requestId);

  if (msg.stalePolicy != null && !STALE_POLICIES.includes(msg.stalePolicy)) {
    return postValidation(panel, s('invalidStalePolicy'), requestId);
  }
  const stalePolicy = threadMode === 'new' ? 'send' : msg.stalePolicy || defaultStalePolicy(prompt);
  let threadRevision = null;
  if (stalePolicy !== 'send') {
    try { threadRevision = await getThreadRevision(await resolveCodexRuntime(), threadId); }
    catch (_) { return postValidation(panel, s('snapshotFailed'), requestId); }
  }

  if (threadMode === 'new') {
    threadId = oldJob?.threadMode === 'new' ? oldJob.threadId || null : null;
  }

  const threadName = threadMode === 'new' ? s('newThread') : normalizeWhitespace(msg.threadName || '') || threadId;
  const boundAccount = await getAccountKey(await resolveCodexRuntime());
  const changes = {
    threadId,
    threadName,
    threadMode,
    prompt,
    accountKey: boundAccount,
    model,
    reasoningEffort,
    stalePolicy,
    threadRevision,
    sendAt,
    sendMode,
    waitDays: sendMode === 'available' ? waitDays : null,
    expiresAt,
    nextCheckAt: sendMode === 'available' ? Date.now() : null,
    availabilityRequestedAt: sendMode === 'available' ? Date.now() : null,
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
  const message = sendMode === 'available' ? s('waitingSaved')
    : s(editId ? 'updatedJob' : 'scheduled', { time: formatDateTime(sendAt) });
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
  if (schedulerPanel) schedulerPanel.webview.postMessage({ type: 'jobs', ...getSnapshot(historyPage) }).then(undefined, () => {});
}

function postValidation(panel, error, requestId) {
  return panel.webview.postMessage({ type: 'validation', requestId, error });
}


module.exports = { initialize, openScheduler, publishJobs, dispose };
