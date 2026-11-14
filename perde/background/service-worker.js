// Context menu, per-tab badge, and the relay between pages and the face model.
// Holds no state of its own: everything lives in chrome.storage, because the worker is
// stopped whenever it is idle.
importScripts('/shared/common.js', '/background/faces.js', '/background/lookup.js');

const { load, save, makeEntry, findEntry, cleanTerm, t, FACE_DATA_KEY } = self.Perde;
const faces = self.PerdeFaces;
const { lookupEntry } = self.PerdeLookup;

const MENU_ID = 'perde-add-selection';
const BADGE_COLOR = '#c4275a';

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: MENU_ID, title: t('menuAddSelection'), contexts: ['selection'] });
  } catch (error) {
    console.error('[Perde] could not create the context menu', error);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const name = cleanTerm(info.selectionText);
  if (name.length < 2) return;

  let added = null;
  let autoLookup = false;
  try {
    const settings = await load();
    autoLookup = settings.autoLookup;
    const existing = findEntry(settings.entries, name);
    if (existing) {
      existing.enabled = true;
    } else {
      added = makeEntry(name);
      settings.entries.push(added);
    }
    await save({ entries: settings.entries });
  } catch (error) {
    console.error('[Perde] could not save the selection', error);
    return;
  }

  // Confirm in the page; the content script also covers the name as soon as storage changes.
  if (tab?.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'perde:toast', text: t('toastAdded', [name]) }, { frameId: 0 });
    } catch {
      // No content script in this tab (for example a chrome:// page).
    }
  }
  if (added && autoLookup) await lookupEntry(added.id);
});

// Requests from pages. Every branch answers asynchronously, so the listener returns true.
const handlers = {
  // A page asks whether an image or a video frame shows a blocked person.
  'perde:face-check': (message) => faces.checkImage(String(message.src), Boolean(message.volatile)),
  // The settings page hands over reference photos the user picked.
  'perde:face-enroll': (message) => faces.enrollImages(String(message.entryId), message.sources ?? []),
  'perde:face-clear': async (message) => {
    await faces.clearFaces(String(message.entryId));
    return { ok: true };
  },
  'perde:face-lookup': (message) => lookupEntry(String(message.entryId)),
  // The offscreen document starts empty and asks for the reference faces.
  'perde:gallery-request': () => faces.buildGallery(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false; // Meant for the offscreen document.

  if (message?.type === 'perde:count') {
    if (sender.tab?.id != null) setBadge(sender.tab.id, message.count);
    return false;
  }

  const handler = handlers[message?.type];
  if (!handler) return false;
  (async () => {
    try {
      sendResponse(await handler(message));
    } catch (error) {
      sendResponse({ error: String(error?.message ?? error) });
    }
  })();
  return true;
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  try {
    if (changes.entries) await faces.pruneFaceData();
    if (changes.entries || changes[FACE_DATA_KEY] || changes.faceStrictness || changes.faceMatch) await faces.pushGallery();
  } catch (error) {
    console.error('[Perde] could not update the face references', error);
  }
});

async function setBadge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 999)) : '' });
  } catch {
    // The tab was closed before the count arrived.
  }
}
