// Builds every Chrome Web Store graphic from the real extension, once per listing language
// (store-assets/en and store-assets/tr): five 1280x800 screenshots and the 440x280 and 1400x560
// promo tiles. The 128px store icon is shared.
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

// Historical figures, public-domain photographs; served under neutral names so only the face can match.
const PORTRAITS = {
  reference: 'File:Einstein_1921_by_F_Schmutzer_-_restoration.jpg',
  blocked: 'File:Albert_Einstein_Head.jpg',
  other: 'File:Niels_Bohr.jpg',
  another: 'File:Marie_Curie_c._1920s.jpg',
};

// Everything that differs between the two listing languages.
const LOCALES = {
  en: {
    profileTitle: 'Deniz Karaca - filmography',
    profileText: 'Films, awards and interviews.',
    portraitsHeading: 'Portraits of the week',
    tagline: 'Blur what you choose not to see',
    words: ['Text', 'Images', 'Video'],
    shots: [
      ['screenshot-1-page.png', 'page', 'popup', 'Blur the people you would rather not see', 'Add a name. Text, images and video about that person are covered on every site, before the page appears.'],
      ['screenshot-2-faces.png', 'faces', null, 'Recognises faces, not only names', 'A photo that shows a blocked person is covered even when no caption mentions them. The check runs on your computer.'],
      ['screenshot-3-whole-page.png', 'notice', null, 'Covers the whole page when it is about them', 'Go back, or show it anyway.'],
      ['screenshot-4-looks.png', 'looks', 'fit', 'Blur, grey block, or gone', 'Choose how covered content looks, and let a click reveal it if you want.'],
      ['screenshot-5-private.png', 'settings', 'fit', 'No account, no server, no tracking', 'Your list and the reference faces stay on your device. Only a name you add is looked up on Wikipedia, and you can turn that off.'],
    ],
  },
  tr: {
    profileTitle: 'Deniz Karaca - filmografi',
    profileText: 'Filmler, ödüller ve söyleşiler.',
    portraitsHeading: 'Haftanın portreleri',
    tagline: 'Görmek istemediğini bulanıklaştır',
    words: ['Yazı', 'Görsel', 'Video'],
    shots: [
      ['screenshot-1-page.png', 'page', 'popup', 'Görmek istemediğin kişileri bulanıklaştır', 'Bir isim ekle. O kişiyle ilgili yazı, görsel ve videolar her sitede, sayfa görünmeden kapatılır.'],
      ['screenshot-2-faces.png', 'faces', null, 'Yalnızca isimleri değil, yüzleri de tanır', 'Altında adı geçmese bile engellediğin kişiyi gösteren fotoğraf kapatılır. Kontrol senin bilgisayarında yapılır.'],
      ['screenshot-3-whole-page.png', 'notice', null, 'Sayfa onunla ilgiliyse tamamını kapatır', 'Geri dön ya da yine de göster.'],
      ['screenshot-4-looks.png', 'looks', 'fit', 'Bulanık, gri blok ya da hiç', 'Kapatılan içeriğin nasıl görüneceğini seç; istersen tek tıkla açılsın.'],
      ['screenshot-5-private.png', 'settings', 'fit', 'Hesap yok, sunucu yok, takip yok', 'Listen ve referans yüzler cihazında kalır. Yalnızca eklediğin isim Wikipedia\'da aranır; bunu da kapatabilirsin.'],
    ],
  },
};

// The test browser always runs in English, and Chrome picks an extension's language from its own
// UI language. For the Turkish captures, load a copy of the extension whose English messages are
// the Turkish ones.
function extensionFor(locale) {
  if (locale === 'en') return { dir: EXTENSION, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perde-ext-'));
  fs.cpSync(EXTENSION, dir, { recursive: true });
  fs.copyFileSync(path.join(EXTENSION, '_locales', locale, 'messages.json'), path.join(dir, '_locales', 'en', 'messages.json'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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
async function capture(locale, portraits) {
  const strings = LOCALES[locale];
  const demo = fs.readFileSync(path.join(SOURCES, `demo.${locale}.html`), 'utf8');
  const profilePage = `<!doctype html><meta charset="utf-8"><title>${strings.profileTitle}</title><body style="font:18px/1.5 Georgia,serif;max-width:760px;margin:40px auto"><h1>Deniz Karaca</h1><p>${strings.profileText}</p></body>`;
  const portraitsPage = `<!doctype html><meta charset="utf-8"><title>${strings.portraitsHeading}</title>
<body style="margin:0;padding:28px 40px;font:16px/1.5 Georgia,serif;background:#fff">
<h2 style="margin:0 0 18px;font-size:26px">${strings.portraitsHeading}</h2>
<div style="display:flex;gap:20px">
  <img src="/img/blocked.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
  <img src="/img/other.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
  <img src="/img/another.jpg" alt="" style="width:250px;height:330px;object-fit:cover">
</div></body>`;
  const extension = extensionFor(locale);
  const server = http.createServer((request, response) => {
    const image = request.url.match(/^\/img\/(\w+)\.jpg/);
    if (image && portraits?.[image[1]]) {
      response.setHeader('content-type', 'image/jpeg');
      response.end(portraits[image[1]]);
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url.startsWith('/person') ? profilePage : request.url.startsWith('/portraits') ? portraitsPage : demo);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perde-store-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--headless=new', `--disable-extensions-except=${extension.dir}`, `--load-extension=${extension.dir}`],
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
    // The card scope shows best in a picture what the extension does; the default covers only the name.
    await setStorage({ faceMatch: false, scope: 'card', entries });

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
    extension.cleanup();
  }
  return shots;
}

async function compose(locale, shots) {
  const strings = LOCALES[locale];
  const out = path.join(ASSETS, locale);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`file://${path.join(SOURCES, 'compose.html')}`);
    for (const [file, main, float, headline, sub] of strings.shots) {
      if (!shots[main]) {
        console.log(`skipped ${locale}/${file} (no capture)`);
        continue;
      }
      await page.evaluate(
        async (data) => {
          document.documentElement.lang = data.locale;
          document.getElementById('headline').textContent = data.headline;
          document.getElementById('sub').textContent = data.sub;
          // A settings capture is shown whole; a page capture runs off the right edge.
          document.querySelector('.main').style.width = data.fit ? '704px' : '';
          for (const [id, src] of [['main', data.main], ['float', data.float]]) {
            const image = document.getElementById(id);
            if (src) {
              image.src = src;
              await image.decode();
            } else {
              image.removeAttribute('src');
            }
          }
          await document.fonts.ready;
        },
        { locale, headline, sub, main: shots[main], float: float && float !== 'fit' ? shots[float] : null, fit: float === 'fit' },
      );
      await page.screenshot({ path: path.join(out, file) });
      console.log(`${locale}/${file}`);
    }

    for (const [source, file, width, height] of [
      ['promo-small.html', 'promo-small-440x280.png', 440, 280],
      ['promo-marquee.html', 'promo-marquee-1400x560.png', 1400, 560],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`file://${path.join(SOURCES, source)}`);
      await page.evaluate(
        async (data) => {
          document.documentElement.lang = data.locale;
          document.getElementById('tagline').textContent = data.tagline;
          document.querySelectorAll('#words span').forEach((span, index) => {
            span.textContent = data.words[index];
          });
          const image = document.getElementById('popup');
          if (image) {
            image.src = data.popup;
            await image.decode();
          }
          await document.fonts.ready;
        },
        { locale, tagline: strings.tagline, words: strings.words, popup: shots.popup },
      );
      await page.screenshot({ path: path.join(out, file) });
      console.log(`${locale}/${file}`);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  let portraits = null;
  try {
    portraits = await downloadPortraits();
  } catch (error) {
    console.log(`no portraits (${error.message}); the face screenshots will be skipped`);
  }
  for (const locale of Object.keys(LOCALES)) {
    await compose(locale, await capture(locale, portraits));
  }
  fs.copyFileSync(path.join(EXTENSION, 'icons', 'icon-128.png'), path.join(ASSETS, 'store-icon-128.png'));
  console.log('store-icon-128.png');
})();
