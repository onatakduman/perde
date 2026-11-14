(async () => {
  'use strict';

  const { load, save, makeEntry, findEntry, cleanTerm, t, ui } = globalThis.Perde;
  const { h } = ui;

  const els = {
    stage: document.getElementById('stage'),
    veilHint: document.getElementById('veil-hint'),
    enabled: document.getElementById('enabled'),
    host: document.getElementById('site-host'),
    status: document.getElementById('site-status'),
    pause: document.getElementById('pause'),
    form: document.getElementById('add-form'),
    name: document.getElementById('add-name'),
    hint: document.getElementById('add-hint'),
    entries: document.getElementById('entries'),
    empty: document.getElementById('empty'),
    options: document.getElementById('open-options'),
  };

  ui.applyI18n();

  let settings = await load();
  let site = await querySite(); // { host, count, active } or null when the page has no content script
  render();
  els.name.focus();

  // The content script of the active tab knows its host and how much it covered; no tab permission needed.
  async function querySite() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) return null;
      return (await chrome.tabs.sendMessage(tab.id, { type: 'perde:state' }, { frameId: 0 })) ?? null;
    } catch {
      return null;
    }
  }

  function render() {
    els.enabled.checked = settings.enabled;
    // Say up front when adding a name will send it somewhere.
    els.hint.textContent = settings.autoLookup ? `${t('addHint')} ${t('addHintLookup')}` : t('addHint');
    renderSite();
    renderEntries();
  }

  function renderSite() {
    const paused = site !== null && settings.pausedHosts.includes(site.host);
    const hasNames = settings.entries.some((entry) => entry.enabled !== false);
    const covering = site !== null && settings.enabled && !paused && hasNames;

    els.host.textContent = site?.host ?? '';
    els.pause.disabled = !site?.host;
    els.pause.checked = paused;
    // Curtain closed: Perde is covering this site. Drawn aside: it is not, for whatever reason.
    els.stage.toggleAttribute('data-open', !covering);

    if (covering && site.count > 0) {
      // "6 covered on this page", with the number set apart.
      const [before, after] = t('siteCount', ['{n}']).split('{n}');
      els.status.replaceChildren(before, h('strong', {}, String(site.count)), after ?? '');
      return;
    }
    let status;
    if (site === null) status = t('siteUnavailable');
    else if (!settings.enabled) status = t('siteOff');
    else if (paused) status = t('sitePaused');
    else if (!hasNames) status = t('siteEmpty');
    else status = t('siteNone');
    els.status.textContent = status;
  }

  function renderEntries() {
    const focusedName = document.activeElement?.closest?.('#entries') ? document.activeElement.name : null;
    els.empty.hidden = settings.entries.length > 0;
    els.veilHint.hidden = settings.entries.length === 0;
    els.entries.replaceChildren(
      ...settings.entries.map((entry) => {
        const toggle = h('input', {
          type: 'checkbox',
          role: 'switch',
          name: `entry-${entry.id}`,
          checked: entry.enabled !== false,
          'aria-label': t('entryToggle', [entry.name]),
        });
        toggle.addEventListener('change', () => updateEntries((entries) => {
          const target = entries.find((item) => item.id === entry.id);
          if (target) target.enabled = toggle.checked;
        }));

        const remove = h('button', { type: 'button', class: 'icon', 'aria-label': t('entryRemove', [entry.name]) }, '✕');
        remove.addEventListener('click', () => updateEntries((entries) => {
          const index = entries.findIndex((item) => item.id === entry.id);
          if (index >= 0) entries.splice(index, 1);
        }));

        const name = h('span', { class: 'entry-name' }, h('span', { class: 'veil' }, entry.name), h('small', {}, entryDetail(entry)));
        return h('li', {}, toggle, name, remove);
      }),
    );
    // Re-rendering replaces the switches, so put keyboard focus back where it was.
    if (focusedName) els.entries.querySelector(`[name="${CSS.escape(focusedName)}"]`)?.focus();
  }

  // "+2 spellings · 5 faces", or the Wikipedia search still running for a name just added.
  function entryDetail(entry) {
    const parts = [];
    if (entry.aliases?.length) parts.push(t('aliasCount', [String(entry.aliases.length)]));
    if (entry.faceCount > 0) parts.push(t('faceBadge', [String(entry.faceCount)]));
    if (entry.lookup?.state === 'pending') parts.push(t('lookupPending'));
    return parts.join(' · ');
  }

  async function updateEntries(change) {
    const entries = structuredClone(settings.entries);
    change(entries);
    await persist({ entries });
  }

  async function persist(patch) {
    try {
      await save(patch);
    } catch (error) {
      console.error('[Perde] could not save', error);
    }
  }

  els.enabled.addEventListener('change', () => persist({ enabled: els.enabled.checked }));

  els.pause.addEventListener('change', () => {
    if (!site?.host) return;
    const hosts = new Set(settings.pausedHosts);
    if (els.pause.checked) hosts.add(site.host);
    else hosts.delete(site.host);
    persist({ pausedHosts: [...hosts] });
  });

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = cleanTerm(els.name.value);
    if (name.length < 2) {
      els.name.focus();
      return;
    }
    let created = null;
    await updateEntries((entries) => {
      const existing = findEntry(entries, name);
      if (existing) {
        existing.enabled = true;
      } else {
        created = makeEntry(name);
        entries.push(created);
      }
    });
    els.form.reset();
    els.name.focus();
    if (created && settings.autoLookup) startLookup(created.id);
  });

  // The search keeps running in the service worker even if this popup is closed before it ends.
  async function startLookup(entryId) {
    try {
      await chrome.runtime.sendMessage({ type: 'perde:face-lookup', entryId });
    } catch {
      // Popup closed, or the worker restarted: the settings page offers the search again.
    }
  }

  els.options.addEventListener('click', async () => {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (error) {
      console.error('[Perde] could not open the settings page', error);
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    settings = await load();
    render();
    // Give the page a moment to re-scan before asking how much is covered now.
    setTimeout(async () => {
      site = await querySite();
      renderSite();
    }, 400);
  });
})();
