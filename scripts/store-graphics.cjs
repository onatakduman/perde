// Builds every Chrome Web Store graphic in store-assets/ from the real extension:
// five 1280x800 screenshots, the 440x280 and 1400x560 promo tiles, and the 128px store icon.
// Each screenshot is a real capture of the extension set into store-assets/src/compose.html.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<path to a Chromium binary> node scripts/store-graphics.cjs
//
// The face-matching screenshot needs the network once: it downloads three public-domain portraits
// from Wikimedia Commons. Without a connection that screenshot is skipped and the rest are built.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'perde');
const ASSETS = path.join(ROOT, 'store-assets');
const SOURCES = path.join(ASSETS, 'src');
const USER_AGENT = 'PerdeStoreGraphics/0.2';

const DEMO = fs.readFileSync(path.join(SOURCES, 'demo.html'), 'utf8');
const PROFILE_PAGE = '<!doctype html><meta charset="utf-8"><title>Deniz Karaca - filmography</title><body style="font:18px/1.5 Georgia,serif;max-width:760px;margin:40px auto"><h1>Deniz Karaca</h1><p>Films, awards and interviews.</p></body>';
const PORTRAITS_PAGE = `<!doctype html><meta charset="utf-8"><title>Portraits</title>
<body style="margin:0;padding:28px 40px;font:16px/1.5 Georgia,serif;background:#fff">
<h2 style="margin:0 0 18px;font-size:26px">Portraits of the week</h2>
<div style="display:flex;gap:20px">
  <img src="/img/blocked.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
  <img src="/img/other.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
  <img src="/img/another.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
</div></body>`;

// Historical figures, public-domain photographs; served under neutral names so only the face can match.
const PORTRAITS = {
  reference: 'File:Einstein_1921_by_F_Schmutzer_-_restoration.jpg',
  blocked: 'File:Albert_Einstein_Head.jpg',
  other: 'File:Niels_Bohr.jpg',
  another: 'File:Marie_Curie_c._1920s.jpg',
};

const SHOTS = [
  {
    file: 'screenshot-1-page.png',
    headline: 'Blur the people you would rather not see',
    sub: 'Add a name. Text, images and video about that person are covered on every site, before the page appears.',
    main: 'page',
    float: 'popup',
  },
  {
    file: 'screenshot-2-faces.png',
    headline: 'Recognises faces, not only names',
    sub: 'A photo that shows a blocked person is covered even when no caption mentions them. The check runs on your computer.',
    main: 'faces',
  },
  {
    file: 'screenshot-3-whole-page.png',
    headline: 'Covers the whole page when it is about them',
    sub: 'Go back, or show it anyway.',
    main: 'notice',
  },
  {
    file: 'screenshot-4-looks.png',
    headline: 'Blur, grey block, or gone',
    sub: 'Choose how covered content looks, and let a click reveal it if you want.',
    main: 'looks',
  },
  {
    file: 'screenshot-5-private.png',
    headline: 'No account, no server, no tracking',
    sub: 'Your list and the reference faces stay on your device. Only a name you add is looked up on Wikipedia, and you can turn that off.',
    main: 'settings',
  },
];

async function downloadPortraits() {
  const titles = Object.values(PORTRAITS).join('|');
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url&iiurlwidth=500&titles=${encodeURIComponent(titles)}`;
  const data = await (await fetch(api, { headers: { 'user-agent': USER_AGENT } })).json();
  const normalized = new Map((data.query.normalized ?? []).map((item) => [item.to, item.from]));
  const images = {};
  for (const page of data.query.pages) {
    const key = Object.keys(PORTRAITS).find((name) => PORTRAITS[name] === (normalized.get(page.title) ?? page.title));
    const response = await fetch(page.imageinfo[0].thumburl, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`could not download ${page.title}`);
    images[key] = Buffer.from(await response.arrayBuffer());
  }
  return images;
}

// Real captures of the extension, at twice the size they are shown, as data URLs.
async function capture(portraits) {
  const server = http.createServer((request, response) => {
    const image = request.url.match(/^\/img\/(\w+)\.jpg/);
    if (image && portraits?.[image[1]]) {
      response.setHeader('content-type', 'image/jpeg');
      response.end(portraits[image[1]]);
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url.startsWith('/person') ? PROFILE_PAGE : request.url.startsWith('/portraits') ? PORTRAITS_PAGE : DEMO);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perde-store-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--headless=new', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
  });
  const shots = {};
  const snap = async (page, options = {}) => `data:image/png;base64,${(await page.screenshot(options)).toString('base64')}`;

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const setStorage = (patch) => worker.evaluate((p) => chrome.storage.local.set(p), patch);
    const entries = [
      { id: 'e1', name: 'Deniz Karaca', aliases: ['Karaca'], enabled: true, faceCount: 6, lookup: { state: 'done', title: 'Deniz Karaca', lang: 'en' } },
      { id: 'e2', name: 'Selim Aydogan', aliases: [], enabled: true, faceCount: 4, lookup: { state: 'done', title: 'Selim Aydogan', lang: 'en' } },
    ];
    // faceMatch is off here because these made-up people have no real reference faces.
    await setStorage({ faceMatch: false, entries });

    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(500);
    shots.page = await snap(page);

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 342, height: 600 });
    await page.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForTimeout(900);
    const popupHeight = await popup.evaluate(() => document.body.getBoundingClientRect().height);
    shots.popup = await snap(popup, { clip: { x: 0, y: 0, width: 342, height: Math.ceil(popupHeight) } });
    await popup.close();

    await page.goto(`${origin}/person/deniz-karaca`);
    await page.waitForTimeout(500);
    shots.notice = await snap(page);

    const options = await context.newPage();
    await options.setViewportSize({ width: 1000, height: 780 });
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.waitForTimeout(700);
    shots.settings = await snap(options);
    await options.evaluate(() => document.getElementById('appearance').scrollIntoView({ behavior: 'instant' }));
    await options.waitForTimeout(300);
    shots.looks = await snap(options);

    if (portraits) {
      await setStorage({ faceMatch: true, entries: [{ id: 'f1', name: 'Zeta Reticuli', aliases: [], enabled: true, faceCount: 0 }] });
      await options.evaluate((src) => chrome.runtime.sendMessage({ type: 'perde:face-enroll', entryId: 'f1', sources: [src] }), `${origin}/img/reference.jpg`);
      await page.goto(`${origin}/portraits`);
      await page.waitForFunction(() => document.querySelectorAll('[data-perde-check]').length === 0 && [...document.images].every((image) => image.complete), null, { timeout: 60000 });
      await page.waitForTimeout(500);
      shots.faces = await snap(page);
    }
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  return shots;
}

async function compose(shots) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`file://${path.join(SOURCES, 'compose.html')}`);
    for (const shot of SHOTS) {
      if (!shots[shot.main]) {
        console.log(`skipped ${shot.file} (no capture)`);
        continue;
      }
      await page.evaluate(
        async ({ headline, sub, main, float }) => {
          document.getElementById('headline').textContent = headline;
          document.getElementById('sub').textContent = sub;
          const images = [['main', main], ['float', float]];
          for (const [id, src] of images) {
            const image = document.getElementById(id);
            if (src) image.src = src;
            else image.removeAttribute('src');
            if (src) await image.decode();
          }
          await document.fonts.ready;
        },
        { headline: shot.headline, sub: shot.sub, main: shots[shot.main], float: shot.float ? shots[shot.float] : null },
      );
      await page.screenshot({ path: path.join(ASSETS, shot.file) });
      console.log(shot.file);
    }

    for (const [source, file, width, height] of [
      ['promo-small.html', 'promo-small-440x280.png', 440, 280],
      ['promo-marquee.html', 'promo-marquee-1400x560.png', 1400, 560],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`file://${path.join(SOURCES, source)}`);
      await page.evaluate(async (popup) => {
        const image = document.getElementById('popup');
        if (image) {
          image.src = popup;
          await image.decode();
        }
        await document.fonts.ready;
      }, shots.popup);
      await page.screenshot({ path: path.join(ASSETS, file) });
      console.log(file);
    }
  } finally {
    await browser.close();
  }
  fs.copyFileSync(path.join(EXTENSION, 'icons', 'icon-128.png'), path.join(ASSETS, 'store-icon-128.png'));
  console.log('store-icon-128.png');
}

(async () => {
  let portraits = null;
  try {
    portraits = await downloadPortraits();
  } catch (error) {
    console.log(`no portraits (${error.message}); the face screenshot will be skipped`);
  }
  await compose(await capture(portraits));
})();
