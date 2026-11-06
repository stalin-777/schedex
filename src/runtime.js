'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const { connectAppServer } = require('./appServerClient');
const { readModels, validateModelSettings } = require('./models');
const { accountKey } = require('./accountIdentity');
const { resetSuggestion } = require('./availabilityPolicy');
const { readThreadRevision } = require('./threadRevision');
const { readTaskProgress } = require('./taskProgress');
const { MAX_OUTPUT_BYTES, MAX_STORE_BYTES, validatePrompt } = require('./limits');

async function withAppServer(runtime, callback) {
  const client = await connectAppServer(runtime);
  try { return await callback(client); }
  finally { client.close(); }
}

function getTaskProgress(runtime, job) {
  return withAppServer(runtime, (client) => readTaskProgress(client.request, job));
}

function getAccountKey(runtime) {
  return withAppServer(runtime, async (client) => accountKey(await client.request('account/read', {})));
}

function queuePrompt(runtime, job, beforeSubmit) {
  validatePrompt(job.prompt);
  return withAppServer(runtime, async (client) => {
    const model = job.sendMode === 'available'
      ? (await client.request('thread/read', { threadId: job.threadId, includeTurns: false })).thread?.model : null;
    await beforeSubmit(client, { model });
    let result;
    try {
      result = await client.request('thread/queue/add', {
        threadId: job.threadId, clientUserMessageId: job.clientMessageId || crypto.randomUUID(),
        input: [{ type: 'text', text: job.prompt, text_elements: [] }]
      });
    } catch (error) {
      if (error.rpcError && ([-32600, -32601, -32602].includes(error.code)
        || /no rollout found|rate.?limit|429/i.test(error.message))) error.submissionRejected = true;
      else error.submissionAttempted = true;
      throw error;
    }
    if (!result?.queuedSubmission?.id) {
      throw Object.assign(new Error('Codex did not return a queue receipt'), { submissionAttempted: true });
    }
    return result.queuedSubmission;
  });
}

function readHistoryProgress(runtime, jobs, isStopped = () => false) {
  return withAppServer(runtime, async (client) => {
    const cache = new Map();
    let bytes = 0;
    const request = async (method, params) => {
      const key = JSON.stringify([method, params]);
      if (cache.has(key)) return cache.get(key).value;
      const value = await client.request(method, params);
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size <= MAX_STORE_BYTES) {
        while (bytes + size > MAX_STORE_BYTES && cache.size) {
          const oldest = cache.keys().next().value;
          bytes -= cache.get(oldest).size;
          cache.delete(oldest);
        }
        cache.set(key, { value, size }); bytes += size;
      }
      return value;
    };
    const updates = [];
    for (const job of jobs) {
      if (isStopped()) break;
      let changes;
      try { changes = { ...await readTaskProgress(request, job), statusError: null }; }
      catch (error) { changes = { statusError: String(error.message || error).slice(0, 2000) }; }
      updates.push({ id: job.id, changes: { ...changes, lastStatusCheckAt: Date.now() } });
    }
    return updates;
  });
}

function getThreadRevision(runtime, threadId) {
  return withAppServer(runtime, (client) => readThreadRevision(client.request, threadId));
}

async function getRateLimitSuggestion(runtime) {
  const result = await appServerRequest(runtime, 'account/rateLimits/read', undefined, 12000);
  return resetSuggestion(result);
}

function getAvailabilityContext(runtime, job) {
  return withAppServer(runtime, async (client) => {
    const key = accountKey(await client.request('account/read', {}));
    let model = job.model;
    if (model) {
      const invalid = validateModelSettings(await readModels(client.request), model, job.reasoningEffort);
      if (invalid) throw Object.assign(new Error(invalid), { code: invalid === 'invalidModel' ? 'MODEL_UNAVAILABLE' : 'INVALID_EFFORT' });
    }
    if (!model && job.threadId) {
      try { model = (await client.request('thread/read', { threadId: job.threadId })).thread?.model; }
      catch (error) {
        // A new thread created before a rejected first turn may have no rollout yet.
        // Read defaults so preparation can replace that provisional ID on this attempt.
        if (job.threadMode !== 'new' || job.threadInitialized !== false || !/no rollout found/i.test(error.message)) throw error;
      }
    }
    if (!model) model = (await client.request('config/read', { includeLayers: false, ...(job.cwd ? { cwd: job.cwd } : {}) })).config?.model;
    if (!model) model = (await readModels(client.request)).find((item) => item.isDefault)?.id;
    return { accountKey: key, model: model || null };
  });
}

function readAvailabilitySnapshot(runtime) {
  return withAppServer(runtime, async (client) => {
    const before = await client.request('account/read', {});
    const key = accountKey(before);
    const limits = await client.request('account/rateLimits/read');
    const after = accountKey(await client.request('account/read', {}));
    if (key !== after || (limits.accountId && before.workspaceRouting?.chatgptAccountId
      && limits.accountId !== before.workspaceRouting.chatgptAccountId)) {
      throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
    }
    return { accountKey: key, limits };
  });
}

function appServerRequest(runtime, method, params, timeoutMs = 12000) {
  return withAppServer(runtime, (client) => client.request(method, params, timeoutMs));
}

function getAvailableModels(runtime) {
  return withAppServer(runtime, (client) => readModels(client.request));
}

async function resolveCodexRuntime() {
  const roots = [];
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (ext?.extensionPath) roots.push(ext.extensionPath);
  roots.push(...fallbackOpenAIExtensionRoots());
  const uniqueRoots = [...new Set(roots.filter(Boolean).filter((p) => fs.existsSync(p)))];
  if (!uniqueRoots.length) throw new Error('official OpenAI Codex extension not found');

  const wsl = getWslInfo();
  if (process.platform === 'win32' && wsl) {
    const linuxBin = findCodexBinary(uniqueRoots, 'linux');
    if (!linuxBin) throw new Error('bundled Codex runtime for WSL not found');
    const wslPath = await toWslPath(linuxBin, wsl.distro);
    return { command: 'wsl.exe', baseArgs: ['-d', wsl.distro, '--', wslPath] };
  }

  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const binary = findCodexBinary(uniqueRoots, platform);
  if (!binary) throw new Error(`bundled Codex runtime for ${platform} not found`);
  return { command: binary, baseArgs: [] };
}

function fallbackOpenAIExtensionRoots() {
  const home = os.homedir();
  const bases = process.platform === 'win32'
    ? [path.join(home, '.vscode', 'extensions')]
    : [path.join(home, '.vscode-server', 'extensions'), path.join(home, '.vscode', 'extensions')];
  const out = [];
  for (const base of bases) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (name.startsWith('openai.chatgpt-')) out.push(path.join(base, name));
      }
    } catch (_) {}
  }
  return out.sort().reverse();
}

function findCodexBinary(roots, platform) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const names = platform === 'linux'
    ? [`bin/linux-${arch}/codex`, 'bin/linux-x86_64/codex', 'bin/linux-aarch64/codex']
    : platform === 'windows'
      ? [`bin/windows-${arch}/codex.exe`, 'bin/windows-x86_64/codex.exe', 'bin/windows-aarch64/codex.exe']
      : [`bin/macos-${arch}/codex`, 'bin/macos-x86_64/codex', 'bin/macos-aarch64/codex'];
  for (const root of roots) {
    for (const rel of names) {
      const candidate = path.join(root, ...rel.split('/'));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const root of roots) {
    const binRoot = path.join(root, 'bin');
    try {
      for (const dir of fs.readdirSync(binRoot)) {
        if (!dir.toLowerCase().includes(platform === 'windows' ? 'windows' : platform === 'macos' ? 'macos' : 'linux')) continue;
        const candidate = path.join(binRoot, dir, platform === 'windows' ? 'codex.exe' : 'codex');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_) {}
  }
  return null;
}

function getWslInfo() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const authority = folder?.uri?.authority || '';
  if (authority.toLowerCase().startsWith('wsl+')) return { distro: decodeURIComponent(authority.slice(4)) };
  if (vscode.env.remoteName === 'wsl' && process.env.WSL_DISTRO_NAME) return { distro: process.env.WSL_DISTRO_NAME };
  return null;
}

function toWslPath(winPath, distro) {
  return new Promise((resolve, reject) => {
    cp.execFile('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', winPath], { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const value = String(stdout).trim();
      if (!value) return reject(new Error('wslpath returned empty path'));
      resolve(value);
    });
  });
}

function getWorkspaceCwdForCodex() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  if (folder.uri.scheme === 'vscode-remote') return folder.uri.path || null;
  return folder.uri.fsPath || null;
}


module.exports = { withAppServer, getRateLimitSuggestion, appServerRequest, getAvailableModels, getAvailabilityContext, getThreadRevision, getTaskProgress,
  getAccountKey, queuePrompt, readHistoryProgress, readAvailabilitySnapshot, resolveCodexRuntime, getWorkspaceCwdForCodex };
