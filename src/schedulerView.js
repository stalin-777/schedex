'use strict';

const vscode = require('vscode');
const { STRINGS, localeKey, continuationPrompts } = require('./i18n');
const { escapeHtml } = require('./utils');

function schedulerHtml(webview, extensionUri) {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'scheduler.css'));
  const scripts = ['threadPicker.js', 'dateTimeFields.js', 'sendModePicker.js', 'modelPicker.js', 'promptFields.js', 'jobList.js', 'scheduler.js']
    .map((file) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)));
  const dict = STRINGS[localeKey()] || STRINGS.en;
  const stringsJson = JSON.stringify({ ...dict, continuationPrompts: continuationPrompts() }).replace(/</g, '\\u003c');
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
      <div class="hint" id="threadSelectionNote" role="status"></div>
    </div>
    <div class="hint" id="newThreadHelp" hidden>${escapeHtml(dict.newThreadHelp)}</div>
  </div>

  <div class="field">
    <label>${escapeHtml(dict.sendMode)}</label>
    <div class="thread-mode" role="group" aria-label="${escapeHtml(dict.sendMode)}">
      <label><input type="radio" name="sendMode" id="whenAvailable" value="available"> ${escapeHtml(dict.sendWhenAvailable)}</label>
      <label><input type="radio" name="sendMode" id="atTime" value="time" checked> ${escapeHtml(dict.sendAtTime)}</label>
    </div>
    <div id="waitingFields" hidden>
      <label for="waitDays">${escapeHtml(dict.waitDays)}</label>
      <input id="waitDays" type="number" min="1" max="30" step="1" value="8">
      <div class="hint">${escapeHtml(dict.availabilityHelp)}</div>
      <div class="hint" id="waitDeadline"></div>
    </div>
  </div>

  <div class="field" id="timedFields">
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
    <div class="model-grid" id="modelFields" hidden>
      <div>
        <label for="model">${escapeHtml(dict.model)}</label>
        <select id="model" disabled></select>
      </div>
      <div>
        <label for="reasoningEffort">${escapeHtml(dict.reasoningEffort)}</label>
        <select id="reasoningEffort" disabled></select>
      </div>
    </div>
    <div class="hint" id="modelsNote">${escapeHtml(dict.existingThreadModelHelp)}</div>
  </div>

  <div class="field">
    <label for="promptTemplate">${escapeHtml(dict.promptTemplate)}</label>
    <select id="promptTemplate"><option value="">${escapeHtml(dict.customPrompt)}</option></select>
    <div class="template-actions">
      <button id="saveTemplate" class="secondary">${escapeHtml(dict.saveTemplate)}</button>
      <button id="deleteTemplate" class="secondary" disabled>${escapeHtml(dict.deleteTemplate)}</button>
    </div>
    <label for="prompt">${escapeHtml(dict.prompt)}</label>
    <textarea id="prompt" maxlength="65536"></textarea>
  </div>

  <div class="field" id="staleFields">
    <label for="stalePolicy">${escapeHtml(dict.stalePolicyLabel)}</label>
    <select id="stalePolicy">
      <option value="send">${escapeHtml(dict.stale_send)}</option>
      <option value="skip" selected>${escapeHtml(dict.stale_skip)}</option>
      <option value="confirm">${escapeHtml(dict.stale_confirm)}</option>
    </select>
    <div class="hint">${escapeHtml(dict.stalePolicyHelp)}</div>
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
    <div class="template-actions">
      <button id="activePrev" class="secondary" disabled>${escapeHtml(dict.previousPage)}</button>
      <span id="activePageInfo" aria-live="polite"></span>
      <button id="activeNext" class="secondary" disabled>${escapeHtml(dict.nextPage)}</button>
    </div>
  </section>
  <section class="scheduled-section" aria-labelledby="historyHeading">
    <h2 id="historyHeading">${escapeHtml(dict.historyHeading)}</h2>
    <div class="template-actions">
      <button id="refreshHistory" class="secondary">${escapeHtml(dict.refreshHistory)}</button>
      <button id="clearHistory" class="secondary">${escapeHtml(dict.clearHistory)}</button>
    </div>
    <div class="hint">${escapeHtml(dict.historyHelp)}</div>
    <div id="historyList"></div>
    <div class="template-actions">
      <button id="historyPrev" class="secondary" disabled>${escapeHtml(dict.previousPage)}</button>
      <span id="historyPageInfo" aria-live="polite"></span>
      <button id="historyNext" class="secondary" disabled>${escapeHtml(dict.nextPage)}</button>
    </div>
  </section>
</main>
<script id="i18n" type="application/json">${stringsJson}</script>
${scripts.map((uri) => `<script src="${uri}"></script>`).join('\n')}
</body>
</html>`;
}


module.exports = { schedulerHtml };
