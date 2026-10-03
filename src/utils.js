'use strict';

function formatDateTime(ms) {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hour}:${minute}`;
}
function normalizeWhitespace(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function truncate(text, max) { const value = normalizeWhitespace(text); return value.length <= max ? value : value.slice(0, max - 1) + '…'; }
function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function errorText(err) { if (!err) return 'unknown error'; return err instanceof Error ? err.message : String(err); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { formatDateTime, normalizeWhitespace, truncate, escapeHtml, errorText, sleep };
