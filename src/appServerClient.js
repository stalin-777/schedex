'use strict';

const cp = require('child_process');
const { readBoundedLines } = require('./boundedLines');
const { MAX_RPC_LINE_BYTES } = require('./limits');
const { version } = require('../package.json');

// A connection owns its pending requests; notifications and server requests have separate paths.
async function connectAppServer(runtime, { onRequest } = {}) {
  const args = ['app-server', '--listen', 'stdio://'];
  const child = cp.spawn(runtime.command, [...runtime.baseArgs, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let stopLines;
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let stderr = '';
  let closed = false;
  let closeError;
  let resolveClosed;
  const whenClosed = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveExited;
  const whenExited = new Promise((resolve) => { resolveExited = resolve; });
  let killTimer;

  function send(message) {
    if (closed || child.stdin.destroyed) throw closeError || new Error('Codex connection closed');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function close(error = new Error('Codex connection closed')) {
    if (closed) return whenExited;
    closed = true;
    closeError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    stopLines?.();
    try { child.stdin.end(); } catch (_) {}
    // The writer lease belongs to the process, not to this RPC connection.
    // Callers handing a thread to Codex must wait for the actual child exit.
    killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    killTimer.unref();
    try { child.kill(); } catch (_) {}
    resolveClosed(error);
    return whenExited;
  }

  function request(method, params, timeoutMs = 12000) {
    if (closed) return Promise.reject(closeError);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`app-server timeout (${method})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-8192); });
  child.stdin.on('error', close);
  child.on('error', close);
  child.on('close', (code) => {
    resolveExited();
    close(new Error(stderr.trim() || `app-server exited with ${code}`));
    clearTimeout(killTimer);
  });
  stopLines = readBoundedLines(child.stdout, MAX_RPC_LINE_BYTES, (line) => {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method) {
      if (Object.hasOwn(message, 'id')) {
        if (onRequest) Promise.resolve().then(() => onRequest(message)).then(
          (result) => { if (!closed) send({ id: message.id, result }); },
          (error) => { if (!closed) send({ id: message.id, error: { code: -32603, message: error.message } }); }
        ).catch(close);
      } else {
        for (const listener of listeners) listener(message);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || JSON.stringify(message.error));
      error.code = message.error.code;
      error.rpcError = true;
      error.data = message.error.data;
      entry.reject(error);
    } else entry.resolve(message.result);
  }, close);

  try {
    await request('initialize', {
      clientInfo: { name: 'schedex', title: 'Schedex', version },
      capabilities: { experimentalApi: true }
    });
    send({ method: 'initialized' });
    return { request, close, whenClosed, onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    } };
  } catch (error) {
    close(error);
    throw error;
  }
}

module.exports = { connectAppServer };
