'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createSendModePicker = function(T) {
  const available = document.getElementById('whenAvailable');
  const atTime = document.getElementById('atTime');
  const timedFields = document.getElementById('timedFields');
  const waitingFields = document.getElementById('waitingFields');
  const waitDays = document.getElementById('waitDays');
  const deadline = document.getElementById('waitDeadline');

  function refresh() {
    timedFields.hidden = available.checked;
    waitingFields.hidden = !available.checked;
  }

  available.addEventListener('change', refresh);
  atTime.addEventListener('change', refresh);
  waitDays.addEventListener('input', () => { deadline.textContent = ''; });
  return {
    getValue: () => ({ sendMode: available.checked ? 'available' : 'time', waitDays: waitDays.value }),
    selectForJob(job) {
      available.checked = job.sendMode === 'available';
      atTime.checked = !available.checked;
      waitDays.value = String(job.waitDays || 8);
      deadline.textContent = available.checked && job.expiresAt
        ? T.waitUntil + ': ' + new Date(job.expiresAt).toLocaleString() : '';
      refresh();
    }
  };
};
