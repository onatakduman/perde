// End-to-end check: loads the unpacked extension into Chromium and drives a fixture page.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<path to a Chromium binary> node tests/e2e.cjs [screenshot-dir]
//
// Branded Google Chrome no longer accepts --load-extension, so this needs Chromium or Chrome for Testing.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const EXTENSION = path.resolve(__dirname, '..', 'perde');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const SHOTS = process.argv[2];

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
}

const marked = (page, selector) => page.evaluate((s) => document.querySelector(s)?.getAttribute('data-perde') ?? null, selector);
const settle = (page) => page.waitForTimeout(350);

async function main() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url.startsWith('/kisi')) {
      response.end('<!doctype html><title>Deniz Karaca - Vikipedi</title><body><h1>Biyografi</h1><p>Uzun bir yazı.</p></body>');
    } else {
      response.end(FIXTURE);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perde-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--headless=new', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1000, height: 900 },
    locale: 'tr-TR',
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    check('service worker starts', Boolean(extensionId));

    const setStorage = (patch) => worker.evaluate((p) => chrome.storage.local.set(p), patch);
    await setStorage({ autoLookup: false, entries: [{ id: 'e1', name: 'Deniz Karaca', aliases: ['Karaca'], enabled: true }] });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/`);
    await settle(page);

    // --- what gets covered
    check('card with the name is covered', (await marked(page, '#card-2')) === 'blur');
    check('other cards stay visible', (await marked(page, '#card-1')) === null && (await marked(page, '#card-3')) === null);
    check('Turkish upper case and suffix match', (await marked(page, '#p-upper')) === 'blur');
    check('alias inside inline markup covers its paragraph', (await marked(page, '#p-alias')) === 'blur');
    check('longer word containing the alias does not match', (await marked(page, '#p-boundary')) === null);
    check('clean paragraph stays visible', (await marked(page, '#p-clean')) === null);
    check('image matched by alt text', (await marked(page, '#img-alt')) === 'blur');
    check('image matched by its link address', (await marked(page, '#img-link')) === 'blur');
    check('unrelated image stays visible', (await marked(page, '#img-clean')) === null);
    check(
      'fields the user types in are left alone',
      (await marked(page, '#field')) === null && (await marked(page, '#area')) === null && (await marked(page, '#editable')) === null,
    );
    check('nothing above the cards is covered', (await marked(page, '#grid')) === null && (await marked(page, 'body')) === null);

    const shadow = await page.evaluate(() => {
      const root = document.getElementById('shadow-host').shadowRoot;
      const hit = root.getElementById('shadow-hit');
      return { hit: hit.getAttribute('data-perde'), clean: root.getElementById('shadow-clean').getAttribute('data-perde'), filter: getComputedStyle(hit).filter };
    });
    check('text inside a shadow root is covered and styled', shadow.hit === 'blur' && shadow.clean === null && shadow.filter.includes('blur'), JSON.stringify(shadow));

    const filter = await page.evaluate(() => getComputedStyle(document.getElementById('card-2')).filter);
    check('covered card is actually blurred', filter === 'blur(16px)', filter);

    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'page-blur.png') });

    // --- content added later
    await page.evaluate(() => window.addCard());
    check('card added after load is covered before the next frame', (await marked(page, '#card-late')) === 'blur');

    // --- reveal on click
    await page.click('#card-2-link');
    await settle(page);
    const afterClick = await page.evaluate(() => ({ revealed: document.getElementById('card-2').hasAttribute('data-perde-revealed'), path: location.pathname }));
    check('first click reveals instead of following the link', afterClick.revealed && afterClick.path === '/', JSON.stringify(afterClick));

    // --- content replaced inside a covered block
    await page.evaluate(() => {
      document.querySelector('#card-late h3').textContent = 'Bambaşka bir haber';
    });
    await settle(page);
    check('block is uncovered when the name is gone', (await marked(page, '#card-late')) === null);

    // --- settings
    await setStorage({ mode: 'cover' });
    await settle(page);
    const cover = await page.evaluate(() => ({ mode: document.getElementById('p-upper').getAttribute('data-perde'), filter: getComputedStyle(document.getElementById('p-upper')).filter }));
    check('switching to the grey block style applies live', cover.mode === 'cover' && cover.filter === 'contrast(0)', JSON.stringify(cover));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'page-cover.png') });

    await setStorage({ mode: 'blur', pausedHosts: ['127.0.0.1'] });
    await settle(page);
    check('pausing the site uncovers everything', (await page.evaluate(() => document.querySelectorAll('[data-perde]').length)) === 0);

    await setStorage({ pausedHosts: [] });
    await settle(page);
    check('resuming covers again', (await marked(page, '#p-upper')) === 'blur');

    await setStorage({ enabled: false });
    await settle(page);
    check('master switch off uncovers everything', (await page.evaluate(() => document.querySelectorAll('[data-perde]').length)) === 0);
    await setStorage({ enabled: true });
    await settle(page);

    // --- popup talks to the page
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 372, height: 560 });
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await settle(popup);
    check('popup lists the blocked name', (await popup.locator('#entries li').count()) === 1);
    await popup.fill('#add-name', 'Festival');
    await popup.press('#add-name', 'Enter');
    await settle(popup);
    const stored = await worker.evaluate(() => chrome.storage.local.get('entries'));
    check('popup form adds a name', stored.entries.length === 2 && stored.entries[1].name === 'Festival');
    await settle(page);
    check('newly added name is covered without reloading', (await marked(page, '#card-1')) === 'blur');
    if (SHOTS) await popup.screenshot({ path: path.join(SHOTS, 'popup.png') });

    const state = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === url || item.pendingUrl === url) ?? tabs.find((item) => !item.url);
      const all = await Promise.all(tabs.map(async (item) => {
        try {
          return await chrome.tabs.sendMessage(item.id, { type: 'perde:state' }, { frameId: 0 });
        } catch {
          return null;
        }
      }));
      return { answered: all.filter(Boolean), tab: Boolean(tab) };
    }, `${origin}/`);
    const answer = state.answered[0];
    check('page reports its host and count to the extension', answer?.host === '127.0.0.1' && answer.count > 0 && answer.active === true, JSON.stringify(state));

    // --- context menu ("block the selected name"); the menu itself cannot be opened from a test,
    // so this fires the same click event Chrome would send.
    const menu = await worker.evaluate(async () => {
      if (typeof chrome.contextMenus.onClicked.dispatch !== 'function') return { supported: false };
      const tabs = await chrome.tabs.query({});
      const replies = await Promise.all(tabs.map(async (item) => {
        try {
          return (await chrome.tabs.sendMessage(item.id, { type: 'perde:state' }, { frameId: 0 })) ? item : null;
        } catch {
          return null;
        }
      }));
      chrome.contextMenus.onClicked.dispatch({ menuItemId: 'perde-add-selection', selectionText: '  Gişe   rakamları ' }, replies.find(Boolean));
      return { supported: true };
    });
    if (menu.supported) {
      await settle(page);
      const names = (await worker.evaluate(() => chrome.storage.local.get('entries'))).entries.map((entry) => entry.name);
      const toast = await page.evaluate(() => document.querySelectorAll('[data-perde-ui]').length);
      check('context menu adds the selected text and confirms in the page', names.includes('Gişe rakamları') && toast === 1 && (await marked(page, '#card-3')) === 'blur', JSON.stringify({ names, toast }));
    } else {
      console.log('SKIP  context menu click (cannot be simulated in this browser)');
    }

    // --- settings page
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await settle(options);
    check('settings page lists entries with their aliases', (await options.inputValue('#aliases-e1')) === 'Karaca');
    await options.check('#mode-cover');
    await options.click('#appearance-form button[type=submit]');
    await settle(options);
    check('appearance form saves on submit', (await worker.evaluate(() => chrome.storage.local.get('mode'))).mode === 'cover');
    if (SHOTS) await options.screenshot({ path: path.join(SHOTS, 'options.png'), fullPage: true });
    await setStorage({ mode: 'blur' });

    // --- whole-page block
    await page.bringToFront();
    await page.goto(`${origin}/kisi/deniz-karaca`);
    await settle(page);
    const blocked = await page.evaluate(() => ({ attr: document.documentElement.hasAttribute('data-perde-page'), filter: getComputedStyle(document.body).filter, notice: Boolean(document.querySelector('[data-perde-ui]')) }));
    check('page whose title matches is covered entirely', blocked.attr && blocked.filter.includes('blur') && blocked.notice, JSON.stringify(blocked));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'page-blocked.png') });

    await setStorage({ blockPage: false });
    await settle(page);
    check('whole-page block can be turned off', !(await page.evaluate(() => document.documentElement.hasAttribute('data-perde-page'))));

    check('no script errors on the page', errors.length === 0, errors.join(' | '));
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
