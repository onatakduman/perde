// Chrome blocks every kind of automation on the Web Store developer dashboard, so the listing
// has to be pasted in by hand. This turns CHROMEWEBSTORE.md into dist/listing-helper.html:
// every field of the dashboard, in the order the dashboard asks for it, with a copy button.
//
//   node scripts/listing-helper.cjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'CHROMEWEBSTORE.md'), 'utf8');
const version = require(path.join(ROOT, 'perde', 'manifest.json')).version;

// ---------------------------------------------------------------- reading CHROMEWEBSTORE.md

const codeBlocks = [...source.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const [descriptionEn, descriptionTr] = codeBlocks;

function lineAfter(heading) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.startsWith(heading));
  return lines.slice(index + 1).find((line) => line.trim() !== '').trim();
}

function justification(permission) {
  const row = source.split('\n').find((line) => line.startsWith(`| \`${permission}\``));
  return row.split('|')[3].trim().replace(/`/g, '');
}

const messages = (locale) => JSON.parse(fs.readFileSync(path.join(ROOT, 'perde', '_locales', locale, 'messages.json'), 'utf8'));
const privacyUrl = source.match(/https:\/\/github\.com\/\S+\/PRIVACY\.md/)[0];
const repoUrl = privacyUrl.replace('/blob/main/PRIVACY.md', '');

if (!descriptionEn || !descriptionTr) throw new Error('could not find both descriptions in CHROMEWEBSTORE.md');

// ---------------------------------------------------------------- the fields, in dashboard order

const assets = (locale) => path.join(ROOT, 'store-assets', locale);
const sections = [
  {
    title: '1. Paket',
    note: 'Paketi zaten yüklediysen bu adımı geç. Dosya seçme penceresinde Cmd+Shift+G ile yolu yapıştırabilirsin.',
    fields: [['Zip dosyasının yolu', path.join(ROOT, 'dist', `perde-v${version}.zip`)]],
  },
  {
    title: '2. Store listing — English',
    note: 'Sekmenin üstündeki dil seçicide English seçiliyken doldur. Kategori: Productivity (ya da Tools). Dil: English.',
    fields: [
      ['Description', descriptionEn],
      ['Görsellerin klasörü (5 ekran görüntüsü, küçük ve büyük tanıtım görseli)', assets('en')],
      ['Mağaza ikonu (128×128)', path.join(ROOT, 'store-assets', 'store-icon-128.png')],
      ['Homepage URL', repoUrl],
      ['Support URL', `${repoUrl}/issues`],
    ],
  },
  {
    title: '3. Store listing — Türkçe',
    note: 'Dil seçiciyi Türkçe yap, sonra doldur. İkon ve adresler aynı kalır.',
    fields: [
      ['Açıklama', descriptionTr],
      ['Görsellerin klasörü (Türkçe set)', assets('tr')],
    ],
  },
  {
    title: '4. Privacy practices',
    note: 'Remote code sorusuna "No, I am not using remote code" de. Veri kullanımı listesinde hiçbir kutuyu işaretleme; alttaki üç beyan kutusunu işaretle.',
    fields: [
      ['Single purpose description', lineAfter('**Single Purpose**')],
      ['storage justification', justification('storage')],
      ['contextMenus justification', justification('contextMenus')],
      ['offscreen justification', justification('offscreen')],
      ['Host permission justification', justification('<all_urls>')],
      ['Privacy policy URL', privacyUrl],
    ],
  },
  {
    title: '5. Distribution',
    note: 'Visibility: Public. Regions: All regions. Sonra "Save draft" ve hazır olduğunda "Submit for review".',
    fields: [],
  },
  {
    title: 'Gerekirse: paketin içindeki ad ve kısa açıklama',
    note: 'Bunlar paketten otomatik gelir; panel sorarsa buradan al.',
    fields: [
      ['Name (English)', messages('en').extName.message],
      ['Summary (English)', messages('en').extDescription.message],
      ['Ad (Türkçe)', messages('tr').extName.message],
      ['Özet (Türkçe)', messages('tr').extDescription.message],
    ],
  },
];

// ---------------------------------------------------------------- the page

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let fieldId = 0;
const body = sections
  .map((section) => {
    const fields = section.fields
      .map(([label, value]) => {
        const id = `field-${++fieldId}`;
        return `
      <div class="field">
        <div class="field-head">
          <h3>${escape(label)}</h3>
          <span class="copy">
            <button type="button" command="--copy" commandfor="${id}" aria-label="Kopyala: ${escape(label)}">Kopyala</button>
            <span class="tip" role="status"></span>
          </span>
        </div>
        <pre id="${id}" tabindex="0">${escape(value)}</pre>
      </div>`;
      })
      .join('');
    return `
    <section>
      <h2>${escape(section.title)}</h2>
      <p class="note">${escape(section.note)}</p>${fields}
    </section>`;
  })
  .join('');

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Perde: mağaza formu</title>
<style>
  @font-face {
    font-family: 'Instrument Sans';
    font-weight: 400 700;
    font-stretch: 75% 100%;
    src: url('../perde/vendor/fonts/instrument-sans-latin.woff2') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F;
  }
  @font-face {
    font-family: 'Instrument Sans';
    font-weight: 400 700;
    font-stretch: 75% 100%;
    src: url('../perde/vendor/fonts/instrument-sans-latin-ext.woff2') format('woff2');
    unicode-range: U+0100-02BA, U+1E00-1E9F;
  }
  :root {
    color-scheme: light dark;
    --paper: light-dark(#f5f4f0, #121212);
    --sheet: light-dark(#ffffff, #1c1c1b);
    --ink: light-dark(#111111, #f5f4f0);
    --ink-2: light-dark(#6b6a66, #a3a29d);
    --hairline: light-dark(#d9d7d0, #343432);
    --signal: light-dark(#c4275a, #ff5c8d);
    font: 15px/1.5 'Instrument Sans', system-ui, sans-serif;
    background: var(--paper);
    color: var(--ink);
  }
  body { margin: 0 auto; max-width: 780px; padding: 48px 24px 96px; }
  h1 { margin: 0 0 8px; font-size: 48px; letter-spacing: -0.035em; line-height: 1; }
  h2 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.03em; }
  h3 { margin: 0; font-size: 15px; }
  p { margin: 0; }
  .lead, .note { color: var(--ink-2); max-width: 62ch; }
  section { padding-block: 28px; border-block-start: 1px solid var(--hairline); }
  section:first-of-type { margin-block-start: 28px; }
  .field { margin-block-start: 18px; }
  .field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-block-end: 6px; }
  pre {
    margin: 0; padding: 12px 14px; max-block-size: 220px; overflow: auto;
    border: 1.5px solid var(--ink); border-radius: 6px; background: var(--sheet);
    font: inherit; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .copy { position: relative; display: inline-flex; align-items: center; gap: 10px; flex-direction: row-reverse; }
  button {
    font: inherit; font-weight: 600; min-inline-size: 24px; min-block-size: 24px; padding: 6px 14px;
    border: 1.5px solid var(--ink); border-radius: 6px; background: var(--ink); color: var(--paper); cursor: pointer;
  }
  button[data-copied] { background: var(--signal); border-color: var(--signal); }
  button[data-failed] { background: transparent; color: var(--ink); }
  :is(button, pre):focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  /* The message is the live region, so it is faded, never removed from the page. */
  .tip { font-size: 13px; color: var(--ink-2); opacity: 0; transition: opacity 0.15s; }
  button:is([data-copied], [data-failed]) + .tip { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
</style>
</head>
<body>
  <h1>Mağaza formu</h1>
  <p class="lead">Chrome Web Store geliştirici panelindeki her alan, panelin sorduğu sırayla. "Kopyala"ya bas, paneldeki alana yapıştır. Kaynak: CHROMEWEBSTORE.md.</p>
  ${body}
<script>
  const timers = new WeakMap();

  async function copy(button, target) {
    const text = target.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      report(button, true);
    } catch {
      report(button, false);
    }
  }

  function report(button, ok) {
    const tip = button.nextElementSibling;
    clearTimeout(timers.get(button));
    button.removeAttribute('data-copied');
    button.removeAttribute('data-failed');
    tip.textContent = '';
    button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
    requestAnimationFrame(() => (tip.textContent = ok ? 'Kopyalandı' : 'Kopyalanamadı'));
    timers.set(button, setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      tip.textContent = '';
    }, 2000));
  }

  if ('command' in HTMLButtonElement.prototype) {
    // "command" events do not bubble, so listen while capturing.
    document.addEventListener('command', (event) => {
      if (event.command === '--copy') copy(event.source, event.target);
    }, true);
  } else {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[commandfor]');
      if (button) copy(button, document.getElementById(button.getAttribute('commandfor')));
    });
  }
</script>
</body>
</html>
`;

const out = path.join(ROOT, 'dist', 'listing-helper.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${fieldId} fields)`);
