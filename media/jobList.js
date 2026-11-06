'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createJobList = function(T, onEdit, onRemove, onDecision, onOpen, onHistoryPage) {
  const jobList = document.getElementById('jobList');
  const historyList = document.getElementById('historyList');
  let history = [];
  let activeJobs = [];
  let activePage = 0;
  let historyPage = 0;
  const pageSize = 25;

  function pageControls(prefix, page, total, size = pageSize) {
    const pages = Math.max(1, Math.ceil(total / size));
    document.getElementById(prefix + 'Prev').disabled = page <= 0;
    document.getElementById(prefix + 'Next').disabled = page + 1 >= pages;
    document.getElementById(prefix + 'PageInfo').textContent = `${page + 1} / ${pages}`;
  }

  function renderActive() {
    activePage = Math.max(0, Math.min(activePage, Math.ceil(activeJobs.length / pageSize) - 1));
    const sorted = activeJobs.slice().sort((a, b) => a.sendAt - b.sendAt);
    renderList(jobList, sorted.slice(activePage * pageSize, (activePage + 1) * pageSize));
    pageControls('active', activePage, activeJobs.length);
  }
  for (const [suffix, delta] of [['Prev', -1], ['Next', 1]]) {
    document.getElementById('active' + suffix).addEventListener('click', () => { activePage += delta; renderActive(); });
    document.getElementById('history' + suffix).addEventListener('click', () => onHistoryPage?.(historyPage + delta));
  }

  function formatDateTime(ms, seconds = false) {
    const value = new Date(ms);
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('/')
      + ' ' + String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0')
      + (seconds ? ':' + String(value.getSeconds()).padStart(2, '0') : '');
  }

  function appendText(container, className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    container.appendChild(element);
    return element;
  }

  function renderList(container, jobs, archived = false) {
    container.textContent = '';
    const sorted = jobs.slice().sort((a, b) => archived ? b.archivedAt - a.archivedAt : a.sendAt - b.sendAt);
    if (!sorted.length) {
      appendText(container, 'hint', archived ? T.emptyHistory : T.emptyJobs);
      return;
    }
    for (const job of sorted) {
      const card = document.createElement('div');
      card.className = 'job-card';
      const top = document.createElement('div');
      top.className = 'job-top';
      const time = document.createElement('span');
      time.className = 'job-time';
      time.textContent = job.sendMode === 'available' ? T.sendWhenAvailable : formatDateTime(job.sendAt);
      const status = document.createElement('span');
      status.className = 'job-status';
      status.dataset.status = job.status || 'scheduled';
      const statuses = { failed: 'Failed', checking: 'Checking', paused: 'Paused', expired: 'Expired', review: 'Review',
        confirmation: 'Confirmation', skipped: 'Skipped', queued: 'Queued', running: 'Running',
        completed: 'Completed', delivered: 'Delivered', cancelled: 'Cancelled', interrupted: 'Interrupted' };
      const state = job.status === 'sending' ? job.turnId ? 'Running' : 'Sending'
        : statuses[job.status] || (job.sendMode === 'available' ? 'Waiting' : 'Scheduled');
      status.textContent = T['status' + state];
      top.append(time, status);
      card.appendChild(top);

      appendText(card, 'job-thread', job.threadMode === 'new' ? T.newThread : job.threadName || job.threadId);
      if (job.threadId) appendText(card, 'job-thread-id', job.threadId);
      const openingBlocked = job.threadMode === 'new'
        && (job.threadInitialized === false || ['checking', 'sending'].includes(job.status));
      if (openingBlocked) appendText(card, 'hint', job.turnId ? T.newThreadRunning : T.newThreadPending);
      appendText(card, 'job-model', job.model
        ? job.model + ' · ' + (job.reasoningEffort ? T['effort_' + job.reasoningEffort] || job.reasoningEffort : T.modelDefault)
        : T.codexDefault);
      if (job.threadMode !== 'new' && job.stalePolicy) {
        appendText(card, 'hint', T.stalePolicyLabel + ': ' + T['stale_' + job.stalePolicy]);
      }
      if (!archived && (job.sendMode === 'available' || job.waitReason || job.nextAttemptAt)) {
        const details = [];
        if (job.waitReason) details.push(T['wait_' + job.waitReason] || job.waitReason);
        if (job.sendMode === 'available' && job.status === 'scheduled' && job.nextCheckAt) {
          details.push(T.nextCheck + ': ' + formatDateTime(Math.min(job.nextCheckAt, job.expiresAt)));
        }
        if (job.estimatedResetAt) details.push(T.estimatedReset + ': ' + formatDateTime(job.estimatedResetAt));
        if (job.sendMode !== 'available' && job.status === 'scheduled' && job.nextAttemptAt) {
          details.push(T.nextAttempt + ': ' + formatDateTime(job.nextAttemptAt));
        }
        if (job.expiresAt) details.push(T.waitUntil + ': ' + formatDateTime(job.expiresAt));
        appendText(card, 'job-waiting', details.join(' · '));
      }
      if (archived || job.acceptedAt) {
        const dates = [['createdAt', T.taskCreated], ['acceptedAt', T.taskDelivered], ['startedAt', T.taskStarted],
          ['finishedAt', T.taskFinished], ['lastStatusCheckAt', T.lastStatusCheck]];
        appendText(card, 'hint', dates.filter(([key]) => job[key]).map(([key, label]) => label + ': '
          + formatDateTime(job[key], key === 'lastStatusCheckAt')).join(' · '));
      }
      if (job.status === 'delivered') {
        appendText(card, 'hint', T.deliveryUntracked);
      }
      if (job.status === 'review') appendText(card, 'hint', archived ? T.reviewArchived : T.reviewNeeded);
      if (job.statusError) {
        appendText(card, 'hint', T.statusReadFailed + ': ' + job.statusError);
      }
      appendText(card, 'job-prompt', job.prompt || '');
      if (job.lastError) {
        appendText(card, 'job-error', job.lastError);
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      if (job.status === 'confirmation') {
        for (const decision of ['send', 'skip']) {
          const button = document.createElement('button');
          button.textContent = decision === 'send' ? T.sendOnce : T.skipSend;
          button.addEventListener('click', () => onDecision(job, decision));
          actions.appendChild(button);
        }
      }
      if (!archived) {
        const edit = document.createElement('button');
        edit.className = 'secondary';
        edit.textContent = T.editJob;
        edit.disabled = ['checking', 'sending'].includes(job.status);
        edit.addEventListener('click', () => onEdit(job));
        const remove = document.createElement('button');
        remove.className = 'secondary';
        remove.textContent = job.status === 'review' ? T.moveToHistory : T.remove;
        remove.disabled = ['checking', 'sending'].includes(job.status);
        remove.addEventListener('click', () => onRemove(job.id));
        actions.append(edit, remove);
      }
      if (job.threadId) {
        const open = document.createElement('button');
        open.className = 'secondary'; open.textContent = T.openInCodex;
        open.disabled = openingBlocked;
        open.addEventListener('click', () => onOpen(job));
        actions.appendChild(open);
      }
      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  function setHistory(items, pagination = {}) {
    history = Array.isArray(items) ? items : [];
    historyPage = pagination.historyPage || 0;
    renderList(historyList, history, true);
    pageControls('history', historyPage, pagination.historyTotal ?? history.length, pagination.historyPageSize || pageSize);
  }
  return { setHistory, render(jobs, items, pagination) {
    activeJobs = jobs;
    renderActive();
    setHistory(Array.isArray(items) ? items : history, pagination);
  } };
};
