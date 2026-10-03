'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createDateTimeFields = function(T) {
  const date = document.getElementById('date');
  const hour = document.getElementById('hour');
  const minute = document.getElementById('minute');
  const resetTime = document.getElementById('resetTime');
  const rateNote = document.getElementById('rateNote');
  let resetSendAtMs = null;
  let timeDirty = false;

  function syncTimeInput(field, max) {
    const value = Number(field.value);
    const valid = /^\d{1,2}$/.test(field.value) && value <= max;
    if (valid) field.setAttribute('aria-valuenow', String(value));
    else field.removeAttribute('aria-valuenow');
    document.getElementById(field.id + 'Minus').disabled = valid && value === 0;
    document.getElementById(field.id + 'Plus').disabled = valid && value === max;
  }

  function setDateTime(ms) {
    const value = new Date(ms);
    date.value = [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('/');
    hour.value = String(value.getHours()).padStart(2, '0');
    minute.value = String(value.getMinutes()).padStart(2, '0');
    syncTimeInput(hour, 23);
    syncTimeInput(minute, 59);
  }

  function stepTime(field, delta, max) {
    const parsed = Number(field.value);
    const current = /^\d{1,2}$/.test(field.value) && parsed <= max ? parsed : 0;
    field.value = String(Math.max(0, Math.min(max, current + delta))).padStart(2, '0');
    syncTimeInput(field, max);
    timeDirty = true;
  }

  for (const [field, max, minusId, plusId] of [
    [hour, 23, 'hourMinus', 'hourPlus'],
    [minute, 59, 'minuteMinus', 'minutePlus']
  ]) {
    field.addEventListener('input', () => {
      field.value = field.value.replace(/\D/g, '').slice(0, 2);
      syncTimeInput(field, max);
      timeDirty = true;
    });
    field.addEventListener('blur', () => {
      if (field.value && Number(field.value) <= max) field.value = String(Number(field.value)).padStart(2, '0');
      syncTimeInput(field, max);
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        stepTime(field, event.key === 'ArrowUp' ? 1 : -1, max);
      }
    });
    document.getElementById(minusId).addEventListener('click', () => stepTime(field, -1, max));
    document.getElementById(plusId).addEventListener('click', () => stepTime(field, 1, max));
  }

  date.addEventListener('input', () => {
    timeDirty = true;
    const digits = date.value.replace(/\D/g, '').slice(0, 8);
    let formatted = digits.slice(0, 4);
    if (digits.length > 4) formatted += '/' + digits.slice(4, 6);
    if (digits.length > 6) formatted += '/' + digits.slice(6, 8);
    date.value = formatted;
  });
  resetTime.addEventListener('click', () => {
    if (resetSendAtMs) {
      setDateTime(resetSendAtMs);
      timeDirty = false;
    }
  });

  return {
    setJobTime(ms) {
      setDateTime(ms);
      timeDirty = true;
    },
    setSuggestion(message) {
      if (!timeDirty) setDateTime(message.sendAtMs || Date.now() + 600000);
      resetSendAtMs = message.resetSendAtMs || null;
      resetTime.disabled = !resetSendAtMs;
      rateNote.textContent = message.rateNote || T.noRateReset;
    },
    getValue: () => ({ date: date.value, hour: hour.value, minute: minute.value })
  };
};
