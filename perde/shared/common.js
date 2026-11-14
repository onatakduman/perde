// Shared by the content script, the service worker and the extension pages.
// Loaded as a classic script everywhere, so it exposes one global: Perde.
(() => {
  'use strict';

  const MODES = ['blur', 'cover', 'hide'];

  // Largest distance between two face descriptors that still counts as the same person.
  const STRICTNESS = Object.freeze({ strict: 0.48, balanced: 0.55, loose: 0.62 });

  // Face descriptors live under their own key so pages that only need names never load them.
  const FACE_DATA_KEY = 'faceData';
  const EXPORT_FORMAT = 'perde-blocklist';

  const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'blur',
    blurRadius: 16,
    revealOnClick: true,
    blockPage: true,
    faceMatch: true,
    facePreBlur: true,
    faceVideo: true,
    faceStrictness: 'balanced',
    autoLookup: true,
    entries: [],
    pausedHosts: [],
  });

  function sanitize(raw) {
    const data = { ...DEFAULTS, ...raw };
    data.enabled = data.enabled !== false;
    data.mode = MODES.includes(data.mode) ? data.mode : DEFAULTS.mode;
    const radius = Number(data.blurRadius);
    data.blurRadius = Number.isFinite(radius) ? Math.min(40, Math.max(4, Math.round(radius))) : DEFAULTS.blurRadius;
    data.revealOnClick = data.revealOnClick !== false;
    data.blockPage = data.blockPage !== false;
    data.faceMatch = data.faceMatch !== false;
    data.facePreBlur = data.facePreBlur !== false;
    data.faceVideo = data.faceVideo !== false;
    data.faceStrictness = data.faceStrictness in STRICTNESS ? data.faceStrictness : DEFAULTS.faceStrictness;
    data.autoLookup = data.autoLookup !== false;
    data.entries = Array.isArray(data.entries) ? data.entries.filter((e) => e && typeof e.name === 'string') : [];
    data.pausedHosts = Array.isArray(data.pausedHosts) ? data.pausedHosts.filter((h) => typeof h === 'string') : [];
    return data;
  }

  async function load() {
    return sanitize(await chrome.storage.local.get(DEFAULTS));
  }

  async function save(patch) {
    await chrome.storage.local.set(patch);
  }

  function makeEntry(name, aliases = []) {
    return { id: crypto.randomUUID(), name: cleanTerm(name), aliases: aliases.map(cleanTerm).filter(Boolean), enabled: true, faceCount: 0 };
  }

  // ---------------------------------------------------------------- faces

  // { [entryId]: number[][] } - one 128-number descriptor per reference photo.
  async function loadFaceData() {
    const { [FACE_DATA_KEY]: data } = await chrome.storage.local.get(FACE_DATA_KEY);
    return data && typeof data === 'object' ? data : {};
  }

  function faceThreshold(settings) {
    return STRICTNESS[settings.faceStrictness] ?? STRICTNESS.balanced;
  }

  // True when there is at least one enabled name with a reference face to compare against.
  function usesFaces(settings) {
    return settings.faceMatch && settings.entries.some((entry) => entry.enabled !== false && entry.faceCount > 0);
  }

  // ---------------------------------------------------------------- backup

  // The same file is read by the macOS app, so keep the shape stable and bump `version` on changes.
  async function exportData() {
    const settings = await load();
    const faces = await loadFaceData();
    const { entries, ...rest } = settings;
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      faceThreshold: faceThreshold(settings),
      settings: rest,
      entries: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        aliases: entry.aliases ?? [],
        enabled: entry.enabled !== false,
        faces: faces[entry.id] ?? [],
      })),
    };
  }

  async function importData(data) {
    if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.entries)) throw new Error('not a Perde backup');
    const faces = {};
    const entries = [];
    for (const item of data.entries) {
      const name = cleanTerm(item?.name);
      if (name.length < 2) continue;
      const entry = makeEntry(name, Array.isArray(item.aliases) ? item.aliases : []);
      entry.enabled = item.enabled !== false;
      const descriptors = (Array.isArray(item.faces) ? item.faces : []).filter(
        (face) => Array.isArray(face) && face.length === 128 && face.every(Number.isFinite),
      );
      if (descriptors.length) faces[entry.id] = descriptors;
      entry.faceCount = descriptors.length;
      entries.push(entry);
    }
    const settings = sanitize({ ...(data.settings ?? {}), entries });
    await chrome.storage.local.set({ ...settings, [FACE_DATA_KEY]: faces });
    return entries.length;
  }

  function cleanTerm(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function parseAliases(text) {
    return [...new Set(String(text ?? '').split(/[,;\n]/).map(cleanTerm).filter(Boolean))];
  }

  // "www.Example.com" -> "example.com"
  function hostKey(hostname) {
    return String(hostname ?? '').toLowerCase().replace(/^www\./, '');
  }

  // Case and accent insensitive form: "NURİ BİLGE" and "nuri bilge" fold to the same text.
  const NON_ASCII = /[^\x00-\x7f]/;

  function fold(text) {
    if (!NON_ASCII.test(text)) return text.toLowerCase(); // Most text on a page: skip the Unicode work.
    return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').toLowerCase();
  }

  // URLs and file names carry names as slugs: "/wiki/Jean-Luc_Godard" -> "wiki jean luc godard".
  function foldUrl(url) {
    let text = String(url).slice(0, 2000);
    try {
      text = decodeURIComponent(text);
    } catch {
      // Malformed escape sequence: match against the raw text.
    }
    return fold(text.replace(/[-_+./=?&#:%~]+/g, ' '));
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  // One regular expression for every enabled name and alias. Returns null when there is nothing to match.
  function buildMatcher(entries) {
    const terms = new Set();
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      for (const raw of [entry.name, ...(entry.aliases ?? [])]) {
        const term = fold(cleanTerm(raw));
        if (term.length >= 2) terms.add(term);
      }
    }
    if (!terms.size) return null;

    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const body = sorted.map((term) => escapeRegExp(term).replace(/[ -]+/g, '[\\s-]+')).join('|');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'u');
    const minLength = Math.min(...sorted.map((term) => term.length));

    return {
      minLength,
      test: (text) => text.length >= minLength && pattern.test(fold(text)),
      testUrl: (url) => url.length >= minLength && pattern.test(foldUrl(url)),
    };
  }

  function findEntry(entries, name) {
    const key = fold(cleanTerm(name));
    return entries.find((entry) => fold(cleanTerm(entry.name)) === key);
  }

  function t(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
  }

  globalThis.Perde = {
    DEFAULTS,
    MODES,
    STRICTNESS,
    FACE_DATA_KEY,
    loadFaceData,
    faceThreshold,
    usesFaces,
    exportData,
    importData,
    load,
    save,
    makeEntry,
    cleanTerm,
    parseAliases,
    hostKey,
    fold,
    foldUrl,
    buildMatcher,
    findEntry,
    t,
  };
})();
