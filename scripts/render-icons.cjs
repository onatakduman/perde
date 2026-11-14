// Renders perde/icons/icon-*.png from store-assets/src/icon.html with Chromium.
//   PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<path to a Chromium binary> node scripts/render-icons.cjs
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.resolve(__dirname, '..');
const ICONS = path.join(ROOT, 'perde', 'icons');
const SOURCE = path.join(ROOT, 'store-assets', 'src', 'icon.html');
const DRAWN_AT = 512; // The source is drawn on a 512 pixel square and scaled down.
const SIZES = { 16: 'small', 32: 'small', 48: 'large', 128: 'large' };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  for (const [size, variant] of Object.entries(SIZES)) {
    // The device scale factor does the downscaling, so the browser draws each size directly.
    const context = await browser.newContext({
      viewport: { width: DRAWN_AT, height: DRAWN_AT },
      deviceScaleFactor: Number(size) / DRAWN_AT,
    });
    const page = await context.newPage();
    await page.goto(`file://${SOURCE}`);
    await page.evaluate(async (id) => {
      document.getElementById(id).classList.add('on');
      await document.fonts.ready;
    }, variant);
    await page.screenshot({ path: path.join(ICONS, `icon-${size}.png`), omitBackground: true });
    await context.close();
    console.log(`icon-${size}.png`);
  }
  await browser.close();
})();
