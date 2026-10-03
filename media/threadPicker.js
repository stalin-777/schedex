'use strict';

window.SchedexComponents = window.SchedexComponents || {};
window.SchedexComponents.createThreadPicker = function(T, onChange) {
  const search = document.getElementById('threadSearch');
  const results = document.getElementById('threadResults');
  const selectedWrap = document.getElementById('selectedWrap');
  const selectedName = document.getElementById('selectedName');
  const selectedId = document.getElementById('selectedId');
  const existingMode = document.getElementById('existingMode');
  const newMode = document.getElementById('newMode');
  const existingThreadFields = document.getElementById('existingThreadFields');
  const newThreadHelp = document.getElementById('newThreadHelp');
  const combo = document.getElementById('combo');
  let threads = [];
  let selectedThread = null;
  let activeIndex = -1;
  let userHasChangedSelection = false;

  function openResults() {
    results.classList.add('open');
    search.setAttribute('aria-expanded', 'true');
  }

  function closeResults() {
    results.classList.remove('open');
    search.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function chooseThread(thread, userInitiated = false) {
    if (userInitiated) userHasChangedSelection = true;
    selectedThread = thread || null;
    if (thread) {
      search.value = thread.name || thread.id;
      selectedName.textContent = thread.name || T.unnamed;
      selectedId.textContent = thread.id;
      selectedWrap.hidden = false;
    } else {
      search.value = '';
      selectedWrap.hidden = true;
    }
    closeResults();
    onChange();
  }

  function filteredThreads() {
    const query = search.value.trim().toLowerCase();
    if (!query || (selectedThread && query === String(selectedThread.name || '').toLowerCase())) return threads;
    return threads.filter((thread) => [thread.name, thread.preview, thread.id]
      .some((value) => String(value || '').toLowerCase().includes(query)));
  }

  function renderResults() {
    const list = filteredThreads();
    results.textContent = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = T.noThreads;
      results.appendChild(empty);
      openResults();
      return;
    }
    if (activeIndex >= list.length) activeIndex = list.length - 1;
    list.forEach((thread, index) => {
      const row = document.createElement('div');
      row.className = 'option' + (index === activeIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.dataset.id = thread.id;
      const title = document.createElement('div');
      title.className = 'option-title';
      title.textContent = thread.name || T.unnamed;
      row.appendChild(title);
      if (thread.preview) {
        const preview = document.createElement('div');
        preview.className = 'option-preview';
        preview.textContent = thread.preview;
        row.appendChild(preview);
      }
      const id = document.createElement('div');
      id.className = 'option-id';
      id.textContent = thread.id;
      row.appendChild(id);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        chooseThread(thread, true);
      });
      results.appendChild(row);
    });
    openResults();
  }

  function setMode(mode) {
    newMode.checked = mode === 'new';
    existingMode.checked = !newMode.checked;
    existingThreadFields.hidden = newMode.checked;
    newThreadHelp.hidden = !newMode.checked;
    onChange();
  }

  function setThreads(list, selectedThreadId) {
    threads = Array.isArray(list) ? list.slice() : [];
    if (userHasChangedSelection) {
      if (selectedThread) {
        const refreshed = threads.find((thread) => thread.id === selectedThread.id);
        if (refreshed) chooseThread(refreshed);
        else threads.unshift(selectedThread);
      }
      return;
    }
    chooseThread(threads.find((thread) => thread.id === selectedThreadId) || threads[0] || null);
  }

  function selectForJob(job) {
    userHasChangedSelection = true;
    setMode(job.threadMode === 'new' ? 'new' : 'existing');
    if (job.threadMode === 'new') return chooseThread(null);
    let thread = threads.find((item) => item.id === job.threadId);
    if (!thread) {
      thread = { id: job.threadId, name: job.threadName || job.threadId, preview: '' };
      threads.unshift(thread);
    }
    chooseThread(thread, true);
  }

  existingMode.addEventListener('change', () => setMode('existing'));
  newMode.addEventListener('change', () => setMode('new'));
  search.addEventListener('focus', renderResults);
  search.addEventListener('input', () => {
    if (!selectedThread || search.value !== selectedThread.name) selectedThread = null;
    userHasChangedSelection = true;
    selectedWrap.hidden = !selectedThread;
    activeIndex = -1;
    renderResults();
    onChange();
  });
  search.addEventListener('keydown', (event) => {
    const list = filteredThreads();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, list.length - 1);
      renderResults();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderResults();
    } else if (event.key === 'Enter' && activeIndex >= 0 && list[activeIndex]) {
      event.preventDefault();
      chooseThread(list[activeIndex], true);
    } else if (event.key === 'Escape') {
      closeResults();
    }
  });
  document.getElementById('toggle').addEventListener('click', () => {
    if (results.classList.contains('open')) closeResults();
    else { search.focus(); renderResults(); }
  });
  document.addEventListener('mousedown', (event) => {
    if (!combo.contains(event.target)) closeResults();
  });

  return {
    setThreads,
    selectForJob,
    getSelectedThread: () => selectedThread,
    getMode: () => newMode.checked ? 'new' : 'existing'
  };
};
