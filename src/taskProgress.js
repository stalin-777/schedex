'use strict';

async function findItem(request, method, params, matches) {
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const result = await request(method, { ...params, cursor, limit: 50 });
    if (!Array.isArray(result?.data)) throw new Error('Codex returned invalid task status data');
    const match = result.data.find(matches);
    if (match) return match;
    cursor = result.nextCursor;
    if (!cursor || seen.has(cursor)) return null;
    seen.add(cursor);
  }
  return null;
}

async function readTaskProgress(request, job) {
  const unknown = () => job.terminalStatusConfirmed
    ? { status: job.status, trackingUnknown: false }
    : { status: job.status === 'review' ? 'review' : 'delivered', trackingUnknown: true };
  const clientMessageId = job.clientMessageId;
  if (!job.turnId && job.queuedSubmissionId) {
    const queued = await findItem(request, 'thread/queue/list', { threadId: job.threadId },
      (item) => item.id === job.queuedSubmissionId);
    if (queued) return { status: 'queued', clientMessageId: queued.clientUserMessageId || clientMessageId || null };
  }
  if (!job.turnId && !clientMessageId) return unknown();
  const turn = await findItem(request, 'thread/turns/list', { threadId: job.threadId, sortDirection: 'desc', itemsView: 'full' },
    (item) => job.turnId ? item.id === job.turnId
      : item.items?.some((message) => message.type === 'userMessage' && message.clientId === clientMessageId));
  if (!turn) return unknown();
  const status = { inProgress: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted' }[turn.status];
  if (!status) return unknown();
  const completedAt = Number.isFinite(turn.completedAt) && turn.completedAt > 0 ? turn.completedAt * 1000 : null;
  // A cold history snapshot can label an unfinished turn interrupted, without a
  // terminal timestamp or error. Keep checking instead of freezing that projection.
  if (status === 'interrupted' && !completedAt && !turn.error) {
    if (job.terminalStatusConfirmed) return { status: job.status, trackingUnknown: false };
    return { status: 'delivered', turnId: turn.id, trackingUnknown: true, terminalStatusConfirmed: false,
      startedAt: turn.startedAt ? turn.startedAt * 1000 : job.startedAt || null,
      finishedAt: null, lastError: null };
  }
  return { status, turnId: turn.id, trackingUnknown: false,
    terminalStatusConfirmed: status !== 'running',
    startedAt: turn.startedAt ? turn.startedAt * 1000 : job.startedAt || null,
    finishedAt: status === 'running' ? null : completedAt,
    lastError: turn.error?.message || null };
}

module.exports = { readTaskProgress };
