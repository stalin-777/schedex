'use strict';

const vscode = require('vscode');
const { connectAppServer } = require('./appServerClient');
const { readModels, validateModelSettings } = require('./models');
const { s } = require('./i18n');
const { validatePrompt } = require('./limits');

const connections = new Set();

function busyError() {
  return Object.assign(new Error(s('threadBusy')), { code: 'THREAD_BUSY', submissionRejected: true });
}

async function handleApproval(message) {
  if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
    throw new Error(s('unsupportedInteraction'));
  }
  const detail = message.params?.command || message.params?.reason || message.method;
  const answer = await vscode.window.showWarningMessage(
    s('approvalNeeded', { detail }), s('approveOnce'), s('denyApproval')
  );
  return { decision: answer === s('approveOnce') ? 'accept' : 'decline' };
}

async function deliverDirect(runtime, job, onStarted, onThreadCreated, beforeSubmit) {
  validatePrompt(job.prompt);
  // Own the resumed thread's writer lock. A shared turn/start could steer a turn
  // started concurrently by the UI, which would ignore this task's model choice.
  const client = await connectAppServer(runtime, { onRequest: handleApproval });
  connections.add(client);
  try { return await runDirectTurn(client, job, onStarted, onThreadCreated, beforeSubmit); }
  finally {
    await client.close();
    connections.delete(client);
  }
}

async function prepareThread(client, job, onThreadCreated) {
  if (!job.threadId && job.threadMode !== 'new') throw new Error(s('invalidThread'));
  if (job.threadId) {
    try {
      const stored = await client.request('thread/read', { threadId: job.threadId, includeTurns: false });
      // Resuming can start a queued submission. Leave it to its owner rather than
      // racing turn/start against it or interrupting it when our client closes.
      const queued = await client.request('thread/queue/list', { threadId: job.threadId, limit: 1 });
      if (queued.data?.length) throw busyError();
      const params = { threadId: job.threadId, excludeTurns: true };
      // A cold resume otherwise uses global defaults instead of this conversation's saved choice.
      if (stored.thread?.model) params.model = stored.thread.model;
      if (stored.thread?.reasoningEffort) params.config = { model_reasoning_effort: stored.thread.reasoningEffort };
      return { previous: await client.request('thread/resume', params), job };
    } catch (error) {
      // New threads are not durable until their first input. A failed preparation
      // can leave a provisional ID, but an accepted conversation must never be replaced.
      if (job.threadMode !== 'new' || job.threadInitialized !== false || !/no rollout found/i.test(error.message)) throw error;
    }
  }
  const params = { threadSource: 'vscode', serviceName: 'schedex' };
  if (job.cwd) params.cwd = job.cwd;
  const previous = await client.request('thread/start', params);
  const threadId = previous.thread?.id;
  if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error('Codex did not return a valid thread ID');
  }
  await onThreadCreated(threadId);
  return { previous, job: { ...job, threadId } };
}

async function runDirectTurn(client, job, onStarted, onThreadCreated, beforeSubmit = async () => {}) {
  const models = job.model ? await readModels(client.request) : [];
  const validation = validateModelSettings(models, job.model, job.reasoningEffort);
  if (validation) throw Object.assign(new Error(s(validation)), { code: validation === 'invalidModel' ? 'MODEL_UNAVAILABLE' : 'INVALID_EFFORT' });
  const selected = models.find((model) => model.id === job.model);
  const effort = job.reasoningEffort || selected?.defaultEffort;
  if (effort && !selected?.efforts.includes(effort)) throw new Error(s('invalidEffort'));

  let previous;
  try {
    ({ previous, job } = await prepareThread(client, job, onThreadCreated));
  } catch (error) {
    if (/active writer|already.*(?:running|in progress)|thread.*busy/i.test(error.message)) throw busyError();
    throw error;
  }
  if (previous.thread?.status?.type === 'active' || previous.thread?.canAcceptDirectInput === false) throw busyError();
  if (previous.thread?.status?.type !== 'idle') throw new Error(s('threadUnavailable'));

  let restore;
  if (job.model) {
    const priorModel = models.find((model) => model.id === previous.model);
    const priorEffort = previous.reasoningEffort ?? priorModel?.defaultEffort;
    if (!previous.model || !priorEffort) throw new Error(s('restoreUnavailable'));
    restore = { threadId: job.threadId, model: previous.model, effort: priorEffort };
    if (previous.collaborationMode) restore.collaborationMode = previous.collaborationMode;
    // Verify the restoring operation before submitting any prompt. This also rejects old servers.
    await client.request('thread/settings/update', restore);
  }

  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const terminalTurns = new Map();
  let turnId;
  const unsubscribe = client.onNotification((message) => {
    if (message.method !== 'turn/completed' || message.params?.threadId !== job.threadId) return;
    const turn = message.params.turn;
    if (!turn?.id) return;
    terminalTurns.set(turn.id, turn);
    if (turn.id === turnId) complete(turn);
  });

  try {
    const params = {
      threadId: job.threadId,
      input: [{ type: 'text', text: job.prompt, text_elements: [] }],
      ...(job.model ? { model: job.model } : {}),
      ...(effort ? { effort } : {})
    };
    if (job.model && previous.collaborationMode) params.collaborationMode = {
      ...previous.collaborationMode,
      settings: { ...previous.collaborationMode.settings, model: job.model, reasoning_effort: effort }
    };
    let started;
    await beforeSubmit(client, { model: job.model || previous.model });
    try { started = await client.request('turn/start', params); }
    catch (error) {
      if (/already.*(?:running|in progress)|thread.*busy/i.test(error.message)) throw busyError();
      if (error.rpcError && [-32600, -32602].includes(error.code)) error.submissionRejected = true;
      else error.submissionAttempted = true;
      throw error;
    }
    turnId = started?.turn?.id;
    if (!turnId) throw Object.assign(new Error(s('sendInterrupted')), { submissionAttempted: true });
    let persistenceError;
    try { await onStarted(turnId); } catch (error) { persistenceError = error; }

    // Restore future-turn settings immediately. The running turn retains its own context.
    if (restore) {
      try { await client.request('thread/settings/update', restore); }
      catch (error) { vscode.window.showWarningMessage(s('restoreFailed', { error: error.message })); }
    }
    if (terminalTurns.has(turnId)) complete(terminalTurns.get(turnId));
    const turn = await Promise.race([
      completed,
      client.whenClosed.then((error) => { throw error; })
    ]);
    if (persistenceError) throw persistenceError;
    if (turn.status !== 'completed') throw Object.assign(new Error(turn.error?.message || s('sendInterrupted')), { turnCompleted: true });
  } catch (error) {
    // A submitted prompt must never be retried automatically because a later operation failed.
    if (turnId) error.turnId = turnId;
    throw error;
  } finally {
    unsubscribe();
  }
}

function dispose() {
  for (const client of connections) client.close(new Error(s('sendInterrupted')));
  connections.clear();
}

module.exports = { deliverDirect, runDirectTurn, dispose };
