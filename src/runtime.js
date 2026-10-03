'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const readline = require('readline');
const { version } = require('../package.json');

async function getRateLimitSuggestion(runtime) {
  const result = await appServerRequest(runtime, 'account/rateLimits/read', undefined, 12000);
  const candidates = [];
  function add(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const key of ['primary', 'secondary']) {
      const bucket = snapshot[key];
      if (!bucket || typeof bucket !== 'object') continue;
      const resetsAt = Number(bucket.resetsAt);
      const duration = Number(bucket.windowDurationMins);
      const usedPercent = Number(bucket.usedPercent);
      if (!Number.isFinite(resetsAt) || resetsAt <= Date.now() / 1000 - 60) continue;
      candidates.push({ resetsAt, duration, usedPercent, reached: Boolean(snapshot.rateLimitReachedType) });
    }
  }
  add(result?.rateLimits);
  if (result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object') {
    for (const snapshot of Object.values(result.rateLimitsByLimitId)) add(snapshot);
  }
  const fiveHour = candidates.filter((c) => c.duration === 300);
  if (!fiveHour.length) return null;
  fiveHour.sort((a, b) => {
    const scoreA = (a.reached ? 1000 : 0) + ((a.usedPercent || 0) >= 99 ? 500 : 0) + (a.usedPercent || 0);
    const scoreB = (b.reached ? 1000 : 0) + ((b.usedPercent || 0) >= 99 ? 500 : 0) + (b.usedPercent || 0);
    return scoreB - scoreA || a.resetsAt - b.resetsAt;
  });
  const resetAtMs = fiveHour[0].resetsAt * 1000;
  return { resetAtMs, sendAtMs: resetAtMs + 60 * 1000 };
}

async function appServerRequest(runtime, method, params, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const args = [...runtime.baseArgs, 'app-server', '--listen', 'stdio://'];
    const child = cp.spawn(runtime.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const rl = readline.createInterface({ input: child.stdout });
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => finishReject(new Error(`app-server timeout (${method})`)), timeoutMs);

    child.stderr.on('data', (d) => { stderr += String(d); });
    child.stdin.on('error', finishReject);
    child.on('error', finishReject);
    child.on('close', (code) => {
      if (!finished) finishReject(new Error(stderr.trim() || `app-server exited with ${code}`));
    });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      if (msg.id === 1) {
        if (msg.error) return finishReject(new Error(JSON.stringify(msg.error)));
        send({ method: 'initialized' });
        const request = { method, id: 2 };
        if (params !== undefined) request.params = params;
        send(request);
      } else if (msg.id === 2) {
        if (msg.error) return finishReject(new Error(msg.error.message || JSON.stringify(msg.error)));
        finishResolve(msg.result);
      }
    });

    function send(obj) { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + '\n'); }
    function cleanup() { clearTimeout(timer); rl.close(); try { child.stdin.end(); } catch (_) {} try { child.kill(); } catch (_) {} }
    function finishResolve(value) { if (finished) return; finished = true; cleanup(); resolve(value); }
    function finishReject(err) { if (finished) return; finished = true; cleanup(); reject(err); }

    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'schedex', title: 'Schedex', version } } });
  });
}

async function createCodexThread(runtime, cwd = getWorkspaceCwdForCodex()) {
  const params = { threadSource: 'vscode', serviceName: 'schedex' };
  if (cwd) params.cwd = cwd;
  const result = await appServerRequest(runtime, 'thread/start', params, 12000);
  const id = result?.thread?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Codex did not return a valid thread ID');
  }
  return id.toLowerCase();
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
    cp.execFile('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', winPath], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const value = String(stdout).trim();
      if (!value) return reject(new Error('wslpath returned empty path'));
      resolve(value);
    });
  });
}

function runCodex(runtime, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(runtime.command, [...runtime.baseArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('codex command timeout')); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function getWorkspaceCwdForCodex() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  if (folder.uri.scheme === 'vscode-remote') return folder.uri.path || null;
  return folder.uri.fsPath || null;
}


module.exports = { getRateLimitSuggestion, appServerRequest, createCodexThread, resolveCodexRuntime, runCodex, getWorkspaceCwdForCodex };
