'use strict';

// Buffer UTF-8 bytes until a complete line is available; never retain an
// unbounded partial JSON message from a stalled or incompatible server.
function readBoundedLines(stream, limit, onLine, onOverflow) {
  let parts = [];
  let bytes = 0;
  let stopped = false;
  function onData(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length && !stopped) {
      const end = data.indexOf(10, start);
      const part = data.subarray(start, end < 0 ? data.length : end);
      if (bytes + part.length > limit) {
        stop(); onOverflow(new Error('Codex RPC message exceeds 16 MiB')); return;
      }
      parts.push(part); bytes += part.length;
      if (parts.length >= 1024) parts = [Buffer.concat(parts, bytes)];
      if (end < 0) break;
      const line = Buffer.concat(parts, bytes).toString('utf8');
      parts = []; bytes = 0;
      onLine(line);
      start = end + 1;
    }
  }
  function stop() { stopped = true; parts = []; bytes = 0; stream.off('data', onData); }
  stream.on('data', onData);
  return stop;
}

module.exports = { readBoundedLines };
