'use strict';

function parseLocalSendAt(date, hourText, minuteText) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) return { error: 'invalidDate' };
  if (!/^(?:[01]\d|2[0-3])$/.test(hourText) || !/^[0-5]\d$/.test(minuteText)) {
    return { error: 'invalidTime' };
  }

  const [year, month, day] = date.split('/').map(Number);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (!Number.isFinite(local.getTime()) || local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
    return { error: 'invalidDate' };
  }
  // A daylight-saving transition can skip a local hour even when the date exists.
  if (local.getHours() !== hour || local.getMinutes() !== minute) return { error: 'invalidTime' };
  return { sendAt: local.getTime() };
}

module.exports = { parseLocalSendAt };
