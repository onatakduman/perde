(async () => {
  'use strict';

  const { load, save, makeEntry, findEntry, cleanTerm, parseAliases, exportData, importData, t, ui } = globalThis.Perde;
  const { h } = ui;

  const REFERENCE_PHOTO_SIDE = 800; // Picked photos are scaled down to this before they go to the model.

  const els = {
    addForm: document.getElementById('add-form'),
    addName: document.getElementById('add-name'),
    addAliases: document.getElementById('add-aliases'),
    listHead: document.getElementById('list-head'),
    entries: document.getElementById('entries'),
    empty: document.getElementById('empty'),
    appearanceForm: document.getElementById('appearance-form'),
    radius: document.getElementById('radius'),
    radiusValue: document.getElementById('radius-value'),
    appearanceStatus: document.getElementById('appearance-status'),
    reveal: document.getElementById('reveal'),
    blockPage: document.getElementById('block-page'),
    faceMatch: document.getElementById('face-match'),
    facePreBlur: document.getElementById('face-preblur'),
    faceVideo: document.getElementById('face-video'),
    autoLookup: document.getElementById('auto-lookup'),
    strictnessForm: document.getElementById('strictness-form'),
    strictnessStatus: document.getElementById('strictness-status'),
    paused: document.getElementById('paused-list'),
    sections: document.getElementById('sections'),
    pausedEmpty: document.getElementById('paused-empty'),
    exportButton: document.getElementById('export'),
    importFile: document.getElementById('import-file'),
    backupStatus: document.getElementById('backup-status'),
  };

  // Switches that take effect as soon as they are flipped: element -> settings key.
  const switches = [
    [els.reveal, 'revealOnClick'],
    [els.blockPage, 'blockPage'],
    [els.faceMatch, 'faceMatch'],
    [els.facePreBlur, 'facePreBlur'],
    [els.faceVideo, 'faceVideo'],
    [els.autoLookup, 'autoLookup'],
  ];

  // What happened to an entry's photos just now; shown until the next action on that entry.
  const notices = new Map(); // entry id -> text

  ui.applyI18n();
  document.title = t('optionsTitle');

  let settings = await load();
  render();
  renderForms();

  function render() {
    renderEntries();
    for (const [input, key] of switches) input.checked = settings[key];
    renderPaused();
  }

  // Forms keep what the user picked until they press save, so they are filled in only once.
  function renderForms() {
    els.appearanceForm.elements.mode.value = settings.mode;
    els.radius.value = String(settings.blurRadius);
    renderRadius();
    els.strictnessForm.elements.faceStrictness.value = settings.faceStrictness;
  }

  // ---------------------------------------------------------------- block list

  function renderEntries() {
    const focusedName = document.activeElement?.closest?.('#entries') ? document.activeElement.name : null;
    const hasEntries = settings.entries.length > 0;
    els.empty.hidden = hasEntries;
    els.listHead.hidden = !hasEntries;
    els.entries.replaceChildren(...settings.entries.map(renderEntry));
    if (focusedName) els.entries.querySelector(`[name="${CSS.escape(focusedName)}"]`)?.focus();
  }

  function renderEntry(entry) {
    const toggle = h('input', {
      type: 'checkbox',
      role: 'switch',
      name: `enabled-${entry.id}`,
      checked: entry.enabled !== false,
      'aria-label': t('entryToggle', [entry.name]),
    });
    toggle.addEventListener('change', () => updateEntry(entry.id, (target) => {
      target.enabled = toggle.checked;
    }));

    const nameId = `name-${entry.id}`;
    const name = h('input', { type: 'text', id: nameId, name: nameId, value: entry.name, required: true, minlength: '2', maxlength: '80', autocomplete: 'off', spellcheck: 'false' });
    name.addEventListener('change', () => {
      const value = cleanTerm(name.value);
      if (value.length < 2) {
        name.value = entry.name; // An entry cannot lose its name; removing it has its own button.
        return;
      }
      updateEntry(entry.id, (target) => {
        target.name = value;
      });
    });

    const aliasesId = `aliases-${entry.id}`;
    const aliases = h('input', { type: 'text', id: aliasesId, name: aliasesId, value: (entry.aliases ?? []).join(', '), autocomplete: 'off', spellcheck: 'false' });
    aliases.addEventListener('change', () => updateEntry(entry.id, (target) => {
      target.aliases = parseAliases(aliases.value);
    }));

    const remove = h('button', { type: 'button', class: 'icon', name: `remove-${entry.id}`, 'aria-label': t('entryRemove', [entry.name]) }, '✕');
    remove.addEventListener('click', () => updateEntries((entries) => {
      const index = entries.findIndex((item) => item.id === entry.id);
      if (index >= 0) entries.splice(index, 1);
    }));

    return h(
      'li',
      { class: 'entry' },
      toggle,
      h('div', { class: 'field' }, h('label', { class: 'visually-hidden', for: nameId }, t('nameColumn')), name),
      h('div', { class: 'field aliases' }, h('label', { class: 'visually-hidden', for: aliasesId }, t('aliasesColumn')), aliases),
      remove,
      renderFaces(entry),
    );
  }

  // Reference faces of one entry: how many, where they came from, and the ways to add more.
  function renderFaces(entry) {
    const searching = entry.lookup?.state === 'pending';

    const lookup = h('button', { type: 'button', class: 'quiet', name: `lookup-${entry.id}`, disabled: searching, 'aria-label': t('lookupFor', [entry.name]) }, t('lookupButton'));
    lookup.addEventListener('click', async () => {
      notices.delete(entry.id);
      await ask({ type: 'perde:face-lookup', entryId: entry.id });
    });

    const photosId = `photos-${entry.id}`;
    const photos = h('input', { type: 'file', id: photosId, name: photosId, accept: 'image/*', multiple: true });
    photos.addEventListener('change', () => enrollPhotos(entry.id, [...photos.files]));

    const clear = h('button', { type: 'button', class: 'quiet', name: `clear-${entry.id}`, hidden: !(entry.faceCount > 0), 'aria-label': t('clearFacesFor', [entry.name]) }, t('clearFaces'));
    clear.addEventListener('click', async () => {
      notices.delete(entry.id);
      await ask({ type: 'perde:face-clear', entryId: entry.id });
    });

    return h(
      'div',
      { class: 'faces' },
      h('span', { class: 'face-status', role: 'status' }, faceStatus(entry)),
      lookup,
      h('label', { class: 'visually-hidden', for: photosId }, t('addPhotos', [entry.name])),
      photos,
      clear,
    );
  }

  function faceStatus(entry) {
    if (notices.has(entry.id)) return notices.get(entry.id);
    const parts = [entry.faceCount > 0 ? t('faceCount', [String(entry.faceCount)]) : t('faceNone')];
    const lookup = entry.lookup;
    if (lookup?.state === 'pending') parts.push(t('lookupPending'));
    else if (lookup?.state === 'done') parts.push(t('lookupDone', [lookup.title]));
    else if (lookup?.state === 'none') parts.push(t('lookupNone'));
    else if (lookup?.state === 'error') parts.push(t('lookupError'));
    return parts.join(' · ');
  }

  async function enrollPhotos(entryId, files) {
    if (!files.length) return;
    notices.set(entryId, t('enrollWorking'));
    renderEntries();
    try {
      const sources = [];
      for (const file of files) sources.push(await toDataUrl(file));
      const result = await ask({ type: 'perde:face-enroll', entryId, sources });
      if (!result) throw new Error('no answer');
      notices.set(entryId, t('enrollResult', [String(result.added), String(result.skipped)]));
    } catch (error) {
      console.error('[Perde] could not read the photos', error);
      notices.set(entryId, t('enrollError'));
    }
    renderEntries();
  }

  // Photos straight from a camera are far larger than the model needs.
  async function toDataUrl(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, REFERENCE_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  function updateEntry(id, change) {
    return updateEntries((entries) => {
      const target = entries.find((item) => item.id === id);
      if (target) change(target);
    });
  }

  async function updateEntries(change) {
    const entries = structuredClone(settings.entries);
    change(entries);
    await persist({ entries });
  }

  els.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = cleanTerm(els.addName.value);
    if (name.length < 2) {
      els.addName.focus();
      return;
    }
    const aliases = parseAliases(els.addAliases.value);
    let created = null;
    await updateEntries((entries) => {
      const existing = findEntry(entries, name);
      if (existing) {
        existing.enabled = true;
        existing.aliases = [...new Set([...(existing.aliases ?? []), ...aliases])];
      } else {
        created = makeEntry(name, aliases);
        entries.push(created);
      }
    });
    els.addForm.reset();
    els.addName.focus();
    if (created && settings.autoLookup) await ask({ type: 'perde:face-lookup', entryId: created.id });
  });

  // ---------------------------------------------------------------- appearance

  function renderRadius() {
    els.radiusValue.textContent = `${els.radius.value}px`;
    els.appearanceForm.style.setProperty('--sample-radius', `${els.radius.value}px`); // The blur sample follows the slider.
    els.radius.disabled = els.appearanceForm.elements.mode.value !== 'blur';
  }

  els.appearanceForm.addEventListener('input', () => {
    renderRadius();
    els.appearanceStatus.textContent = '';
  });

  els.appearanceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saved = await persist({
      mode: els.appearanceForm.elements.mode.value,
      blurRadius: Number(els.radius.value),
    });
    if (saved) els.appearanceStatus.textContent = t('saved');
  });

  // ---------------------------------------------------------------- switches and face sensitivity

  for (const [input, key] of switches) {
    input.addEventListener('change', () => persist({ [key]: input.checked }));
  }

  els.strictnessForm.addEventListener('input', () => {
    els.strictnessStatus.textContent = '';
  });

  els.strictnessForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saved = await persist({ faceStrictness: els.strictnessForm.elements.faceStrictness.value });
    if (saved) els.strictnessStatus.textContent = t('saved');
  });

  // ---------------------------------------------------------------- paused sites

  function renderPaused() {
    els.pausedEmpty.hidden = settings.pausedHosts.length > 0;
    els.paused.replaceChildren(
      ...settings.pausedHosts.map((host) => {
        const resume = h('button', { type: 'button', 'aria-label': t('resumeSite', [host]) }, t('resume'));
        resume.addEventListener('click', () => persist({ pausedHosts: settings.pausedHosts.filter((item) => item !== host) }));
        return h('li', {}, h('span', {}, host), resume);
      }),
    );
  }

  // ---------------------------------------------------------------- backup

  els.exportButton.addEventListener('click', async () => {
    try {
      const blob = new Blob([JSON.stringify(await exportData(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      h('a', { href: url, download: 'perde-blocklist.json' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      console.error('[Perde] could not export', error);
    }
  });

  els.importFile.addEventListener('change', async () => {
    const [file] = els.importFile.files;
    if (!file) return;
    try {
      const count = await importData(JSON.parse(await file.text()));
      notices.clear();
      settings = await load();
      render();
      renderForms();
      els.backupStatus.textContent = t('importDone', [String(count)]);
    } catch (error) {
      console.error('[Perde] could not import', error);
      els.backupStatus.textContent = t('importError');
    }
    els.importFile.value = '';
  });

  // ---------------------------------------------------------------- section links

  // CSS marks the link of the section on screen (scroll-target-group); assistive technology
  // needs the same thing said with aria-current, and older Chrome needs the marking done here.
  const sectionLinks = [...els.sections.querySelectorAll('a')];

  function markCurrent(current) {
    for (const link of sectionLinks) {
      link.classList.toggle('target-current', link === current && !CSS.supports('scroll-target-group: auto'));
      if (link === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }

  if (CSS.supports('scroll-target-group: auto')) {
    const sync = () => markCurrent(els.sections.querySelector('a:target-current'));
    sync();
    document.addEventListener('scrollend', sync);
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) markCurrent(sectionLinks.find((link) => link.getAttribute('href') === `#${visible.target.id}`));
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    for (const section of document.querySelectorAll('main > section')) observer.observe(section);
  }

  // ---------------------------------------------------------------- storage and messaging

  async function persist(patch) {
    try {
      await save(patch);
      return true;
    } catch (error) {
      console.error('[Perde] could not save', error);
      return false;
    }
  }

  // Asks the service worker to do something that needs the face model or the network.
  async function ask(message) {
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (reply?.error) throw new Error(reply.error);
      return reply;
    } catch (error) {
      console.error('[Perde] request failed', message.type, error);
      return null;
    }
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    settings = await load();
    render();
  });
})();
