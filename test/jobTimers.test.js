'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createJobTimers } = require('../src/jobTimers');

for (const entry of ['startup', 'recovery timer']) {
  test(`${entry} reports recovery failures and keeps the next recovery check`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = { id: 'interrupted', status: 'checking' };
    const failure = Object.assign(new Error('Cannot release recovery lock'), { code: 'EACCES' });
    const errors = [];
    let attempts = 0;
    const timers = createJobTimers({
      getJobs: () => [job],
      removeCompletedJobIfPresent: async () => false,
      isInFlight: () => false,
      onTimerError: (error) => errors.push(error),
      recoverInterruptedJob: async () => {
        if (++attempts === 1) throw failure;
        job.status = 'scheduled';
      }
    });
    t.after(() => timers.dispose());
    if (entry === 'startup') await timers.restoreTimers();
    else {
      timers.scheduleSendingRecovery(job.id);
      t.mock.timers.tick(30000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(errors, [failure]);
    assert.equal(attempts, 1);
    t.mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2, 'an error notification must not stop recovery retries');
    assert.equal(job.status, 'scheduled');
    assert.deepEqual(errors, [failure]);
  });
}
