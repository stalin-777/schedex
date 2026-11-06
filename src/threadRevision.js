'use strict';

const { createHash } = require('crypto');

function fingerprint(turn) {
  if (turn && (typeof turn.id !== 'string' || !Array.isArray(turn.items)
    || (turn.itemsView && turn.itemsView !== 'full'))) throw new Error('Codex did not return full message history');
  const items = (turn?.items || []).filter((item) => ['userMessage', 'agentMessage'].includes(item.type));
  if (items.some((item) => typeof item.id !== 'string' || !item.id
    || (item.type === 'userMessage' ? !Array.isArray(item.content) : typeof item.text !== 'string'))) {
    throw new Error('Codex did not return complete message identities');
  }
  const messages = items.map((item) => item.type === 'userMessage'
      ? { id: item.id, type: item.type, content: item.content }
      : { id: item.id, type: item.type, text: item.text });
  // Ignore titles, settings, tools and timestamps. Streaming message updates and
  // a new (or reverted) turn still invalidate the snapshot.
  return createHash('sha256').update(JSON.stringify({ turnId: turn?.id || null, messages })).digest('hex');
}

async function readThreadRevision(request, threadId) {
  try {
    const result = await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
    if (!Array.isArray(result?.data)) throw new Error('Codex did not return thread history');
    return fingerprint(result.data[0]);
  } catch (error) {
    if (error.code !== -32601 && !/unknown method|method.*not found/i.test(error.message)) throw error;
    const result = await request('thread/read', { threadId, includeTurns: true });
    if (!Array.isArray(result?.thread?.turns)) throw new Error('Codex did not return thread history', { cause: error });
    return fingerprint(result.thread.turns.at(-1));
  }
}

module.exports = { readThreadRevision };
