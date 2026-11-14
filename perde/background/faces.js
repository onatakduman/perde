// Service worker side of face matching: owns the offscreen document that runs the model,
// stores reference faces, and keeps the model's copy of them up to date.
(() => {
  'use strict';

  const { load, loadFaceData, faceThreshold, FACE_DATA_KEY } = self.Perde;

  const OFFSCREEN_URL = 'offscreen/offscreen.html';
  const MAX_FACES_PER_ENTRY = 20;

  // Only guards against two calls racing within one worker lifetime; nothing is lost if the worker restarts.
  let creating = null;

  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    creating ??= chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Decodes images and runs the on-device face matching model.',
    });
    try {
      await creating;
    } finally {
      creating = null;
    }
  }

  async function askOffscreen(message) {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    if (reply?.error) throw new Error(reply.error);
    return reply;
  }

  // Reference faces of every enabled name, in the shape the offscreen document expects.
  async function buildGallery() {
    const settings = await load();
    const faces = await loadFaceData();
    return {
      threshold: faceThreshold(settings),
      people: settings.faceMatch
        ? settings.entries
            .filter((entry) => entry.enabled !== false && faces[entry.id]?.length)
            .map((entry) => ({ id: entry.id, descriptors: faces[entry.id] }))
        : [],
    };
  }

  async function pushGallery() {
    if (!(await chrome.offscreen.hasDocument())) return; // It asks for the gallery itself when it starts.
    await askOffscreen({ type: 'face:gallery', gallery: await buildGallery() });
  }

  function checkImage(src, volatile) {
    return askOffscreen({ type: 'face:check', src, volatile });
  }

  async function describeImage(src) {
    const { faces } = await askOffscreen({ type: 'face:describe', src });
    return faces;
  }

  // Appends descriptors to an entry and records how many it has. Reads the stored state again
  // right before writing, because the settings page may have edited the list in the meantime.
  async function addDescriptors(entryId, descriptors, patch = {}) {
    const settings = await load();
    const entry = settings.entries.find((item) => item.id === entryId);
    if (!entry) return 0;

    const faces = await loadFaceData();
    const merged = [...(faces[entryId] ?? []), ...descriptors].slice(0, MAX_FACES_PER_ENTRY);
    faces[entryId] = merged;
    entry.faceCount = merged.length;
    Object.assign(entry, patch);
    await chrome.storage.local.set({ entries: settings.entries, [FACE_DATA_KEY]: faces });
    return merged.length;
  }

  async function patchEntry(entryId, patch) {
    const settings = await load();
    const entry = settings.entries.find((item) => item.id === entryId);
    if (!entry) return;
    Object.assign(entry, patch);
    await chrome.storage.local.set({ entries: settings.entries });
  }

  // Reference photos the user picked: use the largest face of each.
  async function enrollImages(entryId, sources) {
    const descriptors = [];
    let skipped = 0;
    for (const src of sources) {
      try {
        const [face] = await describeImage(src);
        if (face) descriptors.push(face.descriptor);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    const total = descriptors.length ? await addDescriptors(entryId, descriptors) : null;
    return { added: descriptors.length, skipped, total };
  }

  async function clearFaces(entryId) {
    const settings = await load();
    const faces = await loadFaceData();
    delete faces[entryId];
    const entry = settings.entries.find((item) => item.id === entryId);
    if (entry) entry.faceCount = 0;
    await chrome.storage.local.set({ entries: settings.entries, [FACE_DATA_KEY]: faces });
  }

  // Drops descriptors of entries that no longer exist. Writes only when something changed,
  // so the storage listener that calls this does not loop.
  async function pruneFaceData() {
    const settings = await load();
    const faces = await loadFaceData();
    const known = new Set(settings.entries.map((entry) => entry.id));
    const orphans = Object.keys(faces).filter((id) => !known.has(id));
    if (!orphans.length) return;
    for (const id of orphans) delete faces[id];
    await chrome.storage.local.set({ [FACE_DATA_KEY]: faces });
  }

  self.PerdeFaces = {
    buildGallery,
    pushGallery,
    checkImage,
    describeImage,
    addDescriptors,
    patchEntry,
    enrollImages,
    clearFaces,
    pruneFaceData,
  };
})();
