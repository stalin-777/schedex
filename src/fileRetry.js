'use strict';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Sharing violations can temporarily block Windows file operations. Retry only
// the filesystem operation, never the Codex request or the job itself.
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

module.exports = { retryFileOperation };
