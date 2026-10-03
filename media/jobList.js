'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createJobList = function(T, onEdit, onRemove) {
  const jobList = document.getElementById('jobList');

  function formatDateTime(ms) {
    const value = new Date(ms);
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('/')
      + ' ' + String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0');
  }

  function render(jobs) {
    jobList.textContent = '';
    const sorted = jobs.slice().sort((a, b) => a.sendAt - b.sendAt);
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = T.emptyJobs;
      jobList.appendChild(empty);
      return;
    }
    for (const job of sorted) {
      const card = document.createElement('div');
      card.className = 'job-card';
      const top = document.createElement('div');
      top.className = 'job-top';
      const time = document.createElement('span');
      time.className = 'job-time';
      time.textContent = formatDateTime(job.sendAt);
      const status = document.createElement('span');
      status.className = 'job-status';
      status.textContent = T['status' + (job.status === 'sending' ? 'Sending' : job.status === 'failed' ? 'Failed' : 'Scheduled')];
      top.append(time, status);
      card.appendChild(top);

      const thread = document.createElement('div');
      thread.className = 'job-thread';
      thread.textContent = job.threadMode === 'new' ? T.newThread : job.threadName || job.threadId;
      card.appendChild(thread);
      const preview = document.createElement('div');
      preview.className = 'job-prompt';
      preview.textContent = job.prompt || '';
      card.appendChild(preview);
      if (job.lastError) {
        const failure = document.createElement('div');
        failure.className = 'job-error';
        failure.textContent = job.lastError;
        card.appendChild(failure);
      }

      const actions = document.createElement('div');
      actions.className = 'job-actions';
      const edit = document.createElement('button');
      edit.className = 'secondary';
      edit.textContent = T.editJob;
      edit.disabled = job.status === 'sending';
      edit.addEventListener('click', () => onEdit(job));
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = T.remove;
      remove.disabled = job.status === 'sending';
      remove.addEventListener('click', () => onRemove(job.id));
      actions.append(edit, remove);
      card.appendChild(actions);
      jobList.appendChild(card);
    }
  }

  return { render };
};
