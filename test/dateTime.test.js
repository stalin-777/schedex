'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseLocalSendAt } = require('../src/dateTime');

test('accepts a real local date and time', () => {
  const result = parseLocalSendAt('2026/10/01', '14', '05');
  assert.equal(result.error, undefined);
  const date = new Date(result.sendAt);
  assert.deepEqual([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()], [2026, 9, 1, 14, 5]);
});

test('rejects invalid dates and times', () => {
  assert.equal(parseLocalSendAt('2026/02/29', '12', '00').error, 'invalidDate');
  assert.equal(parseLocalSendAt('2026/13/01', '12', '00').error, 'invalidDate');
  assert.equal(parseLocalSendAt('2026/10/01', '24', '00').error, 'invalidTime');
  assert.equal(parseLocalSendAt('2026/10/01', '12', '60').error, 'invalidTime');
});

test('rejects a local time skipped by daylight saving', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(parseLocalSendAt('2026/03/08', '02', '30').error, 'invalidTime');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
