// Fast checks that need no browser: every script parses, the manifest and both locale files are
// valid and agree with each other, and the version is the same everywhere.
//
//   node scripts/check.cjs
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'perde');
const problems = [];

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : scripts(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

for (const file of [...scripts(EXTENSION), ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.cjs')).map((name) => path.join(ROOT, 'scripts', name)), ...fs.readdirSync(path.join(ROOT, 'tests')).filter((name) => name.endsWith('.cjs')).map((name) => path.join(ROOT, 'tests', name))]) {
  // The offscreen page is the only ES module; everything else is a classic script.
  const isModule = file.endsWith(path.join('offscreen', 'offscreen.js'));
  try {
    if (isModule) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: fs.readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'] });
    else execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`${path.relative(ROOT, file)} does not parse: ${String(error.stderr).split('\n')[0]}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} differs from package.json ${pkg.version}`);

for (const file of Object.values(manifest.icons)) {
  if (!fs.existsSync(path.join(EXTENSION, file))) problems.push(`manifest names a missing icon: ${file}`);
}

const locales = Object.fromEntries(
  fs
    .readdirSync(path.join(EXTENSION, '_locales'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()) // Finder leaves .DS_Store files around.
    .map((entry) => [entry.name, JSON.parse(fs.readFileSync(path.join(EXTENSION, '_locales', entry.name, 'messages.json'), 'utf8'))]),
);
const reference = Object.keys(locales[manifest.default_locale]);
for (const [locale, messages] of Object.entries(locales)) {
  const keys = Object.keys(messages);
  for (const key of reference.filter((item) => !keys.includes(item))) problems.push(`_locales/${locale} is missing "${key}"`);
  for (const key of keys.filter((item) => !reference.includes(item))) problems.push(`_locales/${locale} has an extra "${key}"`);
  // The store rejects a description longer than 132 characters.
  if (messages.extDescription.message.length > 132) problems.push(`_locales/${locale} extDescription is longer than 132 characters`);
}

// Every message key used in the pages and scripts must exist.
const used = new Set();
for (const file of [...scripts(EXTENSION), ...['popup/popup.html', 'options/options.html'].map((name) => path.join(EXTENSION, name))]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\('([A-Za-z]+)'/g)) used.add(match[1]);
  for (const match of text.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z]+)"/g)) used.add(match[1]);
}
for (const key of used) {
  if (!reference.includes(key)) problems.push(`message "${key}" is used but not defined`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`ok: ${reference.length} messages in ${Object.keys(locales).length} locales, version ${manifest.version}`);
