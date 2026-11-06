'use strict';

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TEMPLATES = 100;
const HISTORY_PAGE_SIZE = 25;

function validatePrompt(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw Object.assign(new Error('Prompt exceeds 64 KiB. Shorten it before saving or sending.'), { code: 'PROMPT_TOO_LARGE' });
  }
}

module.exports = { MAX_PROMPT_BYTES, MAX_STORE_BYTES, MAX_OUTPUT_BYTES, MAX_RPC_LINE_BYTES, MAX_TEMPLATES, HISTORY_PAGE_SIZE, validatePrompt };
