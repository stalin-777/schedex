'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { env: { language: 'en' }, Uri: { joinPath: (...parts) => parts.join('/') } };
  return originalLoad.call(this, request, parent, isMain);
};
const { schedulerHtml } = require('../src/schedulerView');
Module._load = originalLoad;

test('webview loads packaged styles and scripts under a restrictive CSP', () => {
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: (uri) => uri };
  const html = schedulerHtml(webview, '/extension');
  assert.match(html, /media\/scheduler\.css/);
  for (const file of ['threadPicker.js', 'dateTimeFields.js', 'modelPicker.js', 'jobList.js', 'scheduler.js']) {
    assert.match(html, new RegExp(`media/${file.replace('.', '\\.')}"`));
  }
  assert.match(html, /class="date-time-grid"/);
  for (const id of ['hourMinus', 'hour', 'hourPlus', 'minuteMinus', 'minute', 'minutePlus']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal((html.match(/role="spinbutton"/g) || []).length, 2);
  assert.doesNotMatch(html, /<select[^>]+id="(?:hour|minute)"/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /unsafe-inline|<style>|<script nonce=/);
  assert.match(html, /id="i18n" type="application\/json"/);
});
