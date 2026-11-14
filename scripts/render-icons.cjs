// Renders perde/icons/icon-*.png from the two SVG sources with Chromium.
//   PLAYWRIGHT_CORE=<path to playwright-core> CHROMIUM=<path to a Chromium binary> node scripts/render-icons.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ICONS = path.resolve(__dirname, '..', 'perde', 'icons');
const SIZES = { 16: 'icon-small.svg', 32: 'icon-small.svg', 48: 'icon.svg', 128: 'icon.svg' };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage();
  for (const [size, source] of Object.entries(SIZES)) {
    const svg = fs.readFileSync(path.join(ICONS, source), 'utf8');
    await page.setViewportSize({ width: Number(size), height: Number(size) });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(ICONS, `icon-${size}.png`), omitBackground: true });
    console.log(`icon-${size}.png`);
  }

  await browser.close();
})();
