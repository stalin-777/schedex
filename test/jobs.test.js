'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, window: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const jobs = require('../src/jobs');
Module._load = originalLoad;

test('concurrent job writes preserve every scheduled job', async () => {
  const data = new Map();
  const globalState = {
    get: (key, fallback) => data.get(key) ?? fallback,
    update: async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      data.set(key, value);
    }
  };
  jobs.initialize({ globalState }, () => {});
  await Promise.all(Array.from({ length: 10 }, (_, index) => jobs.upsertJob({ id: String(index), status: 'scheduled' })));
  assert.equal(jobs.getJobs().length, 10);
  await Promise.all([jobs.removeJob('0'), jobs.upsertJob({ id: '10', status: 'failed' })]);
  assert.equal(jobs.getJobs().length, 10);
  assert.equal(jobs.getJobs().some((job) => job.id === '0'), false);
  jobs.dispose();
});

test('interrupted sends require manual retry after activation', async () => {
  const data = new Map([['schedex.jobs.v1', [{ id: 'interrupted', status: 'sending' }]]]);
  const globalState = { get: (key, fallback) => data.get(key) ?? fallback, update: async (key, value) => data.set(key, value) };
  jobs.initialize({ globalState }, () => {});
  await jobs.restoreTimers();
  const job = jobs.getJobs()[0];
  assert.equal(job.status, 'failed');
  assert.match(job.lastError, /interrupted/);
  jobs.dispose();
});
