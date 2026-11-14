// Face matching check. Needs the network: it downloads public-domain portraits of historical
// figures from Wikimedia Commons (nothing is saved in the repository) and uses the extension's
// own Wikipedia lookup.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<path to a Chromium binary> node tests/faces.cjs [screenshot-dir]
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const EXTENSION = path.resolve(__dirname, '..', 'perde');
const SHOTS = process.argv[2];
const USER_AGENT = 'PerdeExtensionTest/0.2';

// Served under neutral names so that only the face, never the file name, can give the person away.
const PORTRAITS = {
  reference: 'File:Einstein_1921_by_F_Schmutzer_-_restoration.jpg',
  same: 'File:Albert_Einstein_Head.jpg',
  other: 'File:Niels_Bohr.jpg',
  another: 'File:Marie_Curie_c._1920s.jpg',
};

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
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
    if (!response.ok) throw new Error(`could not download ${page.title}: ${response.status}`);
    images[key] = Buffer.from(await response.arrayBuffer());
  }
  return images;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Portreler</title>
<body style="font: 16px system-ui; margin: 24px">
<h1>Portreler</h1>
<img id="same" src="/img/same.jpg" width="240" alt="">
<img id="other" src="/img/other.jpg" width="240" alt="">
<img id="another" src="/img/another.jpg" width="240" alt="">
<img id="tiny" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">
</body>`;

// A <video> fed from a canvas, so the test can decide which face is "on screen".
const VIDEO_PAGE = `<!doctype html><meta charset="utf-8"><title>Video</title>
<body style="margin: 24px">
<video id="video" width="400" muted autoplay playsinline></video>
<canvas id="stage" width="500" height="640" style="display:none"></canvas>
<script>
  const stage = document.getElementById('stage');
  const context = stage.getContext('2d');
  let current = new Image();
  window.show = (name) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => { current = image; resolve(); };
    image.src = '/img/' + name + '.jpg';
  });
  setInterval(() => {
    context.fillStyle = '#222';
    context.fillRect(0, 0, stage.width, stage.height);
    if (current.width) context.drawImage(current, 0, 0, stage.width, stage.width * current.height / current.width);
  }, 100);
  const video = document.getElementById('video');
  video.srcObject = stage.captureStream(10);
  video.play();
</script>
</body>`;

async function main() {
  const images = await downloadPortraits();
  const server = http.createServer((request, response) => {
    const image = request.url.match(/^\/img\/(\w+)\.jpg/);
    if (image && images[image[1]]) {
      response.setHeader('content-type', 'image/jpeg');
      response.end(images[image[1]]);
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url.startsWith('/video') ? VIDEO_PAGE : PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perde-faces-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROMIUM || undefined,
    args: ['--headless=new', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1000, height: 900 },
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const setStorage = (patch) => worker.evaluate((p) => chrome.storage.local.set(p), patch);
    const getStorage = (key) => worker.evaluate((k) => chrome.storage.local.get(k), key);
    await setStorage({ autoLookup: false, entries: [{ id: 'p1', name: 'Zeta Reticuli', aliases: [], enabled: true, faceCount: 0 }] });

    // Requests to the service worker have to come from an extension page.
    const options = await context.newPage();
    const optionErrors = [];
    options.on('pageerror', (error) => optionErrors.push(error.message));
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    const ask = (message) => options.evaluate((m) => chrome.runtime.sendMessage(m), message);

    // --- enrolment from a photo
    let started = Date.now();
    const enrolled = await ask({ type: 'perde:face-enroll', entryId: 'p1', sources: [`${origin}/img/reference.jpg`, `${origin}/img/tiny.jpg`] });
    console.log(`      (model load + first photo: ${Date.now() - started} ms)`);
    check('a reference photo yields one face, a bad file is skipped', enrolled?.added === 1 && enrolled.skipped === 1 && enrolled.total === 1, JSON.stringify(enrolled));
    const stored = await getStorage(['entries', 'faceData']);
    check('descriptor is stored apart from the entry', stored.entries[0].faceCount === 1 && stored.faceData.p1[0].length === 128);

    // --- images on a page
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/`, { waitUntil: 'commit' });
    const preBlurred = await page.evaluate(
      () => new Promise((resolve) => {
        const look = () => {
          const img = document.getElementById('same');
          if (img?.complete) resolve(img.hasAttribute('data-perde-check') || img.hasAttribute('data-perde'));
          else requestAnimationFrame(look);
        };
        look();
      }),
    );
    check('image is already blurred when it finishes loading', preBlurred === true);

    started = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('[data-perde-check]').length === 0, null, { timeout: 60000 });
    console.log(`      (3 images checked: ${Date.now() - started} ms)`);
    const verdict = await page.evaluate(() => Object.fromEntries(['same', 'other', 'another', 'tiny'].map((id) => [id, document.getElementById(id).getAttribute('data-perde')])));
    check('a different photo of the same person is covered', verdict.same === 'blur', JSON.stringify(verdict));
    check('other people stay visible', verdict.other === null && verdict.another === null, JSON.stringify(verdict));
    const distances = {};
    for (const name of ['same', 'other', 'another']) {
      distances[name] = (await ask({ type: 'perde:face-check', src: `${origin}/img/${name}.jpg` })).distance?.toFixed(3);
    }
    console.log(`      (distances to the reference: ${JSON.stringify(distances)}, threshold 0.55)`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'faces-page.png') });

    // --- sensitivity and the on/off switch reach the model
    await setStorage({ faceMatch: false });
    await page.waitForTimeout(600);
    check('turning face matching off uncovers the image', (await page.evaluate(() => document.getElementById('same').getAttribute('data-perde'))) === null);
    await setStorage({ faceMatch: true });
    await page.waitForFunction(() => document.getElementById('same').getAttribute('data-perde') === 'blur', null, { timeout: 30000 });
    check('turning it back on covers it again', true);

    // --- video
    const video = await context.newPage();
    await video.goto(`${origin}/video`);
    await video.evaluate(() => window.show('other'));
    await video.waitForTimeout(2500);
    check('video showing someone else stays visible', (await video.evaluate(() => document.getElementById('video').getAttribute('data-perde'))) === null);
    await video.evaluate(() => window.show('same'));
    started = Date.now();
    await video.waitForFunction(() => document.getElementById('video').getAttribute('data-perde') === 'blur', null, { timeout: 30000 });
    console.log(`      (video covered ${Date.now() - started} ms after the face appeared)`);
    check('video is covered while the blocked face is on screen', true);
    if (SHOTS) await video.screenshot({ path: path.join(SHOTS, 'faces-video.png') });
    await video.evaluate(() => window.show('another'));
    started = Date.now();
    await video.waitForFunction(() => document.getElementById('video').getAttribute('data-perde') === null, null, { timeout: 30000 });
    console.log(`      (video uncovered ${Date.now() - started} ms after the face left)`);
    check('video is uncovered after the face is gone', true);
    await video.close();

    // --- Wikipedia lookup: no photo from the user at all
    await setStorage({ entries: [{ id: 'p2', name: 'Albert Einstein', aliases: [], enabled: true, faceCount: 0 }] });
    started = Date.now();
    const lookup = await ask({ type: 'perde:face-lookup', entryId: 'p2' });
    console.log(`      (lookup: ${Date.now() - started} ms, ${JSON.stringify(lookup)})`);
    const after = await getStorage(['entries', 'faceData']);
    const entry = after.entries[0];
    check('lookup finds the person and reference faces', lookup?.state === 'done' && entry.faceCount >= 1 && after.faceData.p2?.length === entry.faceCount, JSON.stringify(entry));
    check('face data of the removed entry was pruned', after.faceData.p1 === undefined);
    console.log(`      (aliases found: ${JSON.stringify(entry.aliases)})`);

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-perde-check]').length === 0 && document.getElementById('same').complete, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const viaLookup = await page.evaluate(() => Object.fromEntries(['same', 'other', 'another'].map((id) => [id, document.getElementById(id).getAttribute('data-perde')])));
    check('faces found by the lookup cover the right photo only', viaLookup.same === 'blur' && viaLookup.other === null && viaLookup.another === null, JSON.stringify(viaLookup));

    await setStorage({ entries: [...after.entries, { id: 'p3', name: 'Quasar Nebula Xyzzy', aliases: [], enabled: true, faceCount: 0 }] });
    const missing = await ask({ type: 'perde:face-lookup', entryId: 'p3' });
    check('a name that is not a person on Wikipedia is reported as such', missing?.state === 'none', JSON.stringify(missing));

    // --- settings page and backup
    await options.reload();
    await options.waitForTimeout(400);
    const status = await options.locator('.entry .face-status').first().textContent();
    check('settings page shows the faces and their source', /Albert Einstein/.test(status) && /\d/.test(status), status);
    const exported = await options.evaluate(() => Perde.exportData());
    check('export carries names, faces and the threshold', exported.format === 'perde-blocklist' && exported.entries[0].faces[0].length === 128 && exported.faceThreshold === 0.55);
    const imported = await options.evaluate((data) => Perde.importData(data), exported);
    const restored = await getStorage(['entries', 'faceData']);
    check('import restores them', imported === 2 && restored.entries[0].faceCount === exported.entries[0].faces.length && Object.keys(restored.faceData).length === 1, JSON.stringify(restored.entries));
    if (SHOTS) await options.screenshot({ path: path.join(SHOTS, 'options-faces.png'), fullPage: true });

    check('no script errors', errors.length === 0 && optionErrors.length === 0, [...errors, ...optionErrors].join(' | '));
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
