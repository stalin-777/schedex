'use strict';

const crypto = require('crypto');

function accountKey(response) {
  if (response?.account?.type !== 'chatgpt') {
    throw Object.assign(new Error('ChatGPT authentication required'), { code: 'UNSUPPORTED_ACCOUNT' });
  }
  const identity = response.workspaceRouting?.chatgptAccountId || response.account.email;
  if (!identity) throw Object.assign(new Error('Account identity unavailable'), { code: 'AUTH_REQUIRED' });
  return crypto.createHash('sha256').update(JSON.stringify([
    identity, response.workspaceRouting?.backendOrigin || null
  ])).digest('hex');
}

module.exports = { accountKey };
