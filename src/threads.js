'use strict';

const vscode = require('vscode');
const { s } = require('./i18n');
const { normalizeWhitespace, truncate, sleep } = require('./utils');
const { appServerRequest, withAppServer, resolveCodexRuntime } = require('./runtime');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const DEEPLINK_RE = /codex:\/\/threads\/([0-9a-f-]{36})/i;
const THREAD_BINDING_KEY = 'schedex.threadBinding.v1';
const THREAD_PAGE_SIZE = 50;
const MAX_THREAD_PAGES = 10;

let extContext;
function initialize(context) { extContext = context; }

async function resolveCurrentThreadIdNonInteractive(invocationArgs = []) {
  const fromArgs = extractUuidDeep(invocationArgs);
  if (fromArgs) return fromArgs;

  const fromActiveTab = isSidebarInvocation(invocationArgs) ? null : getThreadIdFromActiveTab();
  if (fromActiveTab) return fromActiveTab;

  const fromExports = await probeCodexExtensionExports();
  if (fromExports) return fromExports;

  const fromHiddenCopy = await probeHiddenCopyThreadCommand();
  if (fromHiddenCopy) return fromHiddenCopy;

  return getRememberedThreadBinding();
}

function isSidebarInvocation(args) {
  return args.some((arg) => arg && typeof arg === 'object'
    && /chatgpt|codex/i.test(String(arg.viewId || arg.webviewId || '')));
}

function listRecentThreads(runtime, onPage = () => {}) {
  return withAppServer(runtime, (client) => readRecentThreads(client.request, onPage));
}

async function readRecentThreads(request, onPage) {
  const base = {
    limit: THREAD_PAGE_SIZE,
    sortKey: 'recency_at',
    sortDirection: 'desc',
    sourceKinds: ['vscode'],
    archived: false
  };
  const items = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    let result;
    try {
      result = await request('thread/list', { ...base, cursor }, 12000);
    } catch (error) {
      if (!items.length) throw error;
      break;
    }
    if (!Array.isArray(result?.data)) break;
    items.push(...result.data.map(threadListItem).filter(Boolean));
    await onPage(items.slice());
    const nextCursor = result.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return items;
}

function threadListItem(thread) {
  const id = extractThreadId(thread?.id);
  if (!id) return null;
  const preview = normalizeWhitespace(thread?.preview || '');
  const name = normalizeWhitespace(thread?.name || '') || truncate(preview, 72) || s('unnamed');
  const updatedAt = Number(thread?.updatedAt);
  return {
    id,
    name,
    preview: preview && preview !== name ? truncate(preview, 180) : '',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt * 1000 : null
  };
}


function getThreadIdFromActiveTab() {
  try {
    const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    const input = tab?.input;
    const uris = [];
    if (input?.uri) uris.push(input.uri);
    if (input?.modified) uris.push(input.modified);
    if (input?.original) uris.push(input.original);
    for (const uri of uris) {
      const value = typeof uri?.toString === 'function' ? uri.toString() : String(uri || '');
      if (!/(openai-codex|codex|chatgpt)/i.test(value)) continue;
      const id = extractThreadId(value);
      if (id) return id;
    }
  } catch (_) {}
  return null;
}

async function probeCodexExtensionExports() {
  try {
    const ext = vscode.extensions.getExtension('openai.chatgpt');
    if (!ext) return null;
    if (!ext.isActive) await ext.activate();
    const api = ext.exports;
    if (!api || typeof api !== 'object') return null;
    for (const name of ['getActiveThread', 'getCurrentThread', 'getActiveConversation', 'getCurrentConversation']) {
      if (typeof api[name] !== 'function') continue;
      try {
        const id = extractUuidDeep(await api[name]());
        if (id) return id;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function probeHiddenCopyThreadCommand() {
  let original;
  try {
    const commands = await vscode.commands.getCommands(true);
    const candidates = commands.filter((id) => {
      if (!/^(chatgpt|codex|openai)[.:-]/i.test(id)) return false;
      return /(copy.*(deeplink|session.?id|thread.?id)|(deeplink|session.?id|thread.?id).*copy)/i.test(id);
    });
    if (!candidates.length) return null;
    original = await vscode.env.clipboard.readText();
    for (const command of candidates) {
      try {
        // Empty the probe first so copying the same link is distinguishable from a no-op.
        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand(command);
        await sleep(40);
        const id = extractThreadId(await vscode.env.clipboard.readText());
        if (id) return id;
      } catch (_) {}
    }
  } catch (_) {}
  finally {
    if (original !== undefined) {
      try { await vscode.env.clipboard.writeText(original); } catch (_) {}
    }
  }
  return null;
}

async function bindThreadFromClipboard() {
  const id = extractThreadId(await vscode.env.clipboard.readText());
  if (!id) return vscode.window.showWarningMessage(s('bindMissing'));
  await rememberThreadBinding(id);
  vscode.window.showInformationMessage(s('bindDone'));
}

function extractThreadId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const deep = trimmed.match(DEEPLINK_RE);
  if (deep && UUID_RE.test(deep[1])) return deep[1].toLowerCase();
  const local = trimmed.match(/(?:^|\/)local\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:$|[/?#])/i);
  if (local) return local[1].toLowerCase();
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const any = trimmed.match(UUID_ANY_RE);
  if (any && /(codex|chatgpt|thread|conversation|session)/i.test(trimmed)) return any[0].toLowerCase();
  return null;
}

function extractUuidDeep(value, depth = 0, seen = new Set()) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return extractThreadId(value);
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const preferredKeys = ['threadId', 'thread_id', 'conversationId', 'conversation_id', 'sessionId', 'session_id', 'id', 'deeplink', 'deepLink', 'uri', 'path', 'route', 'resource'];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const id = extractUuidDeep(value[key], depth + 1, seen);
      if (id) return id;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractUuidDeep(item, depth + 1, seen);
      if (id) return id;
    }
  }
  return null;
}


function workspaceBindingKey() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.toString() : '__global__';
}

async function rememberThreadBinding(threadId) {
  if (!extContext || !extractThreadId(threadId)) return;
  const bindings = extContext.globalState.get(THREAD_BINDING_KEY, {});
  bindings[workspaceBindingKey()] = { threadId, at: Date.now(), explicit: true };
  await extContext.globalState.update(THREAD_BINDING_KEY, bindings);
}

function getRememberedThreadBinding() {
  if (!extContext) return null;
  const bindings = extContext.globalState.get(THREAD_BINDING_KEY, {});
  const binding = bindings[workspaceBindingKey()];
  return binding?.explicit ? extractThreadId(binding.threadId || '') : null;
}

async function openThread(threadId) {
  const id = extractThreadId(threadId);
  if (!id) throw new Error(s('invalidThread'));
  const scheme = vscode.env.uriScheme || 'vscode';
  return vscode.env.openExternal(vscode.Uri.parse(`${scheme}://openai.chatgpt/local/${id}`));
}

async function openJobThread(job) {
  if (!job?.threadId) throw new Error(s('invalidThread'));
  if (job.threadMode === 'new') {
    if (job.threadInitialized === false || ['checking', 'sending'].includes(job.status)) {
      vscode.window.showInformationMessage(s(job.turnId ? 'newThreadRunning' : 'newThreadPending'));
      return;
    }
    const runtime = await resolveCodexRuntime();
    for (let attempt = 0; ; attempt++) {
      try {
        await appServerRequest(runtime, 'thread/read', { threadId: job.threadId, includeTurns: false }, 3000);
        break;
      } catch (error) {
        if (!/no rollout found|failed to resolve rollout path .*file does not exist/i.test(error.message)) throw error;
        if (attempt === 3) throw new Error(s('threadNotReady'), { cause: error });
        await sleep(250 * 2 ** attempt);
      }
    }
  }
  return openThread(job.threadId);
}


module.exports = { initialize, resolveCurrentThreadIdNonInteractive, listRecentThreads, bindThreadFromClipboard, extractThreadId, rememberThreadBinding, getRememberedThreadBinding, openThread, openJobThread };
