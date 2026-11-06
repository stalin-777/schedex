'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessAvailability, resetSuggestion, classifyAvailabilityError, errorBackoff, nextWakeAt, MINUTE, DAY } = require('../src/availabilityPolicy');
const { accountKey } = require('../src/accountIdentity');
const now = 1800000000000;
const window = (minutes, used, reset) => ({ windowDurationMins: minutes, usedPercent: used, resetsAt: reset / 1000 });

test('both exhausted windows must recover; moved reset times are respected', () => {
  const data = { ordinaryUsageAllowed: false, rateLimits: {
    primary: window(300, 100, now + 2 * MINUTE), secondary: window(10080, 100, now + 3 * DAY)
  } };
  const waiting = assessAvailability(data, null, now);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.reason, 'weekly');
  assert.equal(waiting.resetAt, now + 3 * DAY);
  assert.equal(waiting.nextCheckAt, now + 15 * MINUTE);
  assert.equal(resetSuggestion(data, null, now).sendAtMs, now + 3 * DAY + MINUTE);
  data.rateLimits.secondary.resetsAt = (now + 10 * MINUTE) / 1000;
  assert.equal(assessAvailability(data, null, now).nextCheckAt, now + 2 * MINUTE);
  assert.equal(resetSuggestion(data, null, now).sendAtMs, now + 10 * MINUTE + MINUTE);
});

test('past resets and low percentages never substitute for backend permission', () => {
  const data = { ordinaryUsageAllowed: null, rateLimits: { primary: window(300, 100, now - MINUTE) } };
  assert.equal(assessAvailability(data, null, now).ready, false);
  data.rateLimits.primary.usedPercent = 0;
  assert.equal(assessAvailability(data, null, now).reason, 'unknown');
  data.ordinaryUsageAllowed = false;
  assert.equal(assessAvailability(data, null, now).ready, false);
  data.ordinaryUsageAllowed = true;
  assert.equal(assessAvailability(data, null, now).ready, true);
  data.rateLimits.spendControlReached = true;
  assert.equal(assessAvailability(data, null, now).ready, false);
});

test('model-specific quotas are applied without blocking on unrelated buckets', () => {
  const data = { ordinaryUsageAllowed: true, rateLimitsByLimitId: {
    codex: { primary: window(300, 20, now + MINUTE) },
    reserve: { normalModelSlug: 'large', secondary: window(10080, 100, now + DAY) }
  } };
  assert.equal(assessAvailability(data, 'small', now).ready, true);
  assert.equal(assessAvailability(data, 'large', now).reason, 'weekly');
});

test('network and service backoff is bounded; permanent problems require intervention', () => {
  assert.equal(classifyAvailabilityError({ code: 'ENOTFOUND', message: 'offline' }).reason, 'network');
  assert.equal(classifyAvailabilityError(new Error('503 service unavailable')).reason, 'service');
  assert.equal(classifyAvailabilityError(new Error('401 unauthorized')).permanent, true);
  assert.equal(classifyAvailabilityError({ code: 'MODEL_UNAVAILABLE' }).reason, 'model');
  assert.deepEqual([1, 2, 3, 4, 100].map(errorBackoff), [1, 2, 5, 15, 15].map((n) => n * MINUTE));
});

test('retry timers preserve requested send times and wake at waiting deadlines', () => {
  assert.equal(nextWakeAt({ sendAt: now, nextAttemptAt: now + MINUTE }), now + MINUTE);
  assert.equal(nextWakeAt({ sendMode: 'available', sendAt: now, nextCheckAt: now + DAY, expiresAt: now + MINUTE }), now + MINUTE);
});

test('account identity survives plan upgrades but changes with the selected workspace', () => {
  const account = { account: { type: 'chatgpt', email: 'test@example.test', planType: 'plus' } };
  assert.equal(accountKey(account), accountKey({
    account: { ...account.account, planType: 'pro' }
  }));
  assert.notEqual(accountKey(account), accountKey({ ...account, workspaceRouting: { chatgptAccountId: 'different' } }));
});
