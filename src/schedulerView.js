'use strict';

const vscode = require('vscode');
const { STRINGS, localeKey } = require('./i18n');
const { escapeHtml } = require('./utils');

function schedulerHtml(webview, extensionUri) {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'scheduler.css'));
  const scripts = ['threadPicker.js', 'dateTimeFields.js', 'jobList.js', 'scheduler.js']
    .map((file) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)));
  const dict = STRINGS[localeKey()] || STRINGS.en;
  const stringsJson = JSON.stringify(dict).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${escapeHtml(localeKey())}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<title>Schedex</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<main>
  <h1>Schedex</h1>
  <div class="sub" id="sub">${escapeHtml(dict.loadingDetail)}</div>

  <div class="field">
    <div class="thread-mode" role="group" aria-label="${escapeHtml(dict.threadDestination)}">
      <label><input type="radio" name="threadMode" id="existingMode" value="existing" checked> ${escapeHtml(dict.existingThread)}</label>
      <label><input type="radio" name="threadMode" id="newMode" value="new"> ${escapeHtml(dict.newThread)}</label>
    </div>
    <div id="existingThreadFields">
      <label for="threadSearch">${escapeHtml(dict.thread)}</label>
      <div class="combo" id="combo">
        <input id="threadSearch" class="combo-input" autocomplete="off" placeholder="${escapeHtml(dict.threadPlaceholder)}" aria-autocomplete="list" aria-expanded="false" aria-controls="threadResults">
        <button id="toggle" class="combo-toggle secondary" title="${escapeHtml(dict.thread)}" aria-label="${escapeHtml(dict.thread)}">⌄</button>
        <div id="threadResults" class="results" role="listbox" aria-label="${escapeHtml(dict.searchResults)}"></div>
      </div>
      <div class="selected" id="selectedWrap" hidden>
        <span class="selected-name" id="selectedName"></span>
        <span class="selected-id" id="selectedId"></span>
      </div>
      <div class="hint">${escapeHtml(dict.threadHelp)}</div>
    </div>
    <div class="hint" id="newThreadHelp" hidden>${escapeHtml(dict.newThreadHelp)}</div>
  </div>

  <div class="field">
    <label>${escapeHtml(dict.sendAt)}</label>
    <div class="date-time-grid">
      <div>
        <label class="field-label" for="date">${escapeHtml(dict.date)}</label>
        <input id="date" type="text" inputmode="numeric" maxlength="10" placeholder="YYYY/MM/DD">
        <div class="hint">${escapeHtml(dict.dateHint)}</div>
      </div>
      <div>
        <div class="field-label" id="timeLabel">${escapeHtml(dict.time)}</div>
        <div class="time-wrap" role="group" aria-labelledby="timeLabel">
          <div class="stepper">
            <button type="button" id="hourMinus" class="stepper-button" aria-label="${escapeHtml(dict.decrease)} ${escapeHtml(dict.hours)}">−</button>
            <input id="hour" type="text" inputmode="numeric" maxlength="2" pattern="[0-9]*" role="spinbutton" aria-valuemin="0" aria-valuemax="23" aria-label="${escapeHtml(dict.hours)}">
            <button type="button" id="hourPlus" class="stepper-button" aria-label="${escapeHtml(dict.increase)} ${escapeHtml(dict.hours)}">+</button>
          </div>
          <span class="time-separator">:</span>
          <div class="stepper">
            <button type="button" id="minuteMinus" class="stepper-button" aria-label="${escapeHtml(dict.decrease)} ${escapeHtml(dict.minutes)}">−</button>
            <input id="minute" type="text" inputmode="numeric" maxlength="2" pattern="[0-9]*" role="spinbutton" aria-valuemin="0" aria-valuemax="59" aria-label="${escapeHtml(dict.minutes)}">
            <button type="button" id="minutePlus" class="stepper-button" aria-label="${escapeHtml(dict.increase)} ${escapeHtml(dict.minutes)}">+</button>
          </div>
        </div>
        <div class="hint">${escapeHtml(dict.timeHint)}</div>
      </div>
    </div>
    <div class="reset-row"><button id="resetTime" class="secondary" disabled>${escapeHtml(dict.resetButton)}</button></div>
    <div class="hint" id="rateNote">${escapeHtml(dict.loading)}</div>
  </div>

  <div class="field">
    <label for="prompt">${escapeHtml(dict.prompt)}</label>
    <textarea id="prompt"></textarea>
  </div>

  <div class="error" id="error"></div>
  <div class="success" id="success"></div>
  <div class="actions">
    <button id="cancelEdit" class="secondary" hidden>${escapeHtml(dict.cancelEdit)}</button>
    <button id="schedule" disabled>${escapeHtml(dict.scheduleButton)}</button>
  </div>

  <section class="scheduled-section" aria-labelledby="scheduledHeading">
    <h2 id="scheduledHeading">${escapeHtml(dict.scheduledHeading)}</h2>
    <div id="jobList"></div>
  </section>
</main>
<script id="i18n" type="application/json">${stringsJson}</script>
${scripts.map((uri) => `<script src="${uri}"></script>`).join('\n')}
</body>
</html>`;
}


module.exports = { schedulerHtml };
