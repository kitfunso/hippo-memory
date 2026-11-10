// Post-build guard: glued inline tags, duplicate ids, DESIGN.md colour drift, locked visible text.
// Run by `npm run build`; `--update` rewrites text-snapshot/ instead of comparing against it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(SITE, 'dist');
const SNAP = join(SITE, 'text-snapshot');
const UPDATE = process.argv.includes('--update');
const GLUE = [/[A-Za-z0-9:;,.)]<(a|code|strong|em)[ >]/g, /<\/(a|code|strong|em)>[A-Za-z(]/g];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', middot: '·' };
const TEXT_FIX = 'Site wording is locked: if this change is meant, run "npm --prefix website run snapshot" and commit website/text-snapshot.';
/** @type {string[]} */
const fails = [];

/** @param {string} msg */
const fail = (msg) => fails.push(`[check-build] FAIL ${msg}`);

/** @param {string} dir @param {RegExp} ext @returns {string[]} */
function walk(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/** @param {string} html @param {string[]} tags @returns {string} */
const strip = (html, tags) => tags.reduce((s, t) => s.replace(new RegExp(`<${t}\\b[\\s\\S]*?</${t}>`, 'gi'), ''), html);

/** @returns {{slug: string, html: string}[]} */
function readPages() {
  return walk(DIST, /^(index|404)\.html$/).sort().map((file) => {
    const rel = relative(DIST, file).split(sep).join('/').replace(/\/?(index\.html|\.html)$/, '');
    return { slug: rel.replaceAll('/', '-') || 'home', html: readFileSync(file, 'utf8') };
  });
}

/** @param {string} html @returns {string[]} 40 characters of context around each glued tag */
function gluedSnippets(html) {
  const code = strip(html, ['script', 'style', 'pre']);
  return GLUE.flatMap((re) => [...code.matchAll(re)].map((m) => code.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, ' ')));
}

/** @param {string} html @returns {string[]} */
function duplicateIds(html) {
  const seen = new Set();
  const dupes = new Set();
  for (const m of strip(html, ['script', 'style']).matchAll(/\sid="([^"]*)"/g)) (seen.has(m[1]) ? dupes : seen).add(m[1]);
  return [...dupes];
}

/** @returns {string[]} lower-case hexes from the DESIGN.md front matter */
function designHexes() {
  const front = readFileSync(join(SITE, 'DESIGN.md'), 'utf8').split(/^---\s*$/m)[1] ?? '';
  return [...new Set((front.match(/#[0-9a-f]{6}\b/gi) ?? []).map((h) => h.toLowerCase()))];
}

/** @param {string[]} hexes @returns {string[]} hexes that no source file uses */
function unusedHexes(hexes) {
  const files = ['src', 'scripts'].flatMap((d) => walk(join(SITE, d), /\.(css|astro|ts|tsx|mjs)$/));
  const code = files.filter((f) => basename(f) !== 'check-build.mjs').map((f) => readFileSync(f, 'utf8').toLowerCase()).join('\n');
  return hexes.filter((h) => !code.includes(h));
}

/** @param {string} e entity body without & and ; @param {string} whole @returns {string} */
function decode(e, whole) {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
}

/** @param {string} html @returns {string} visible text, numbers masked so build-time stats do not flake */
function visibleText(html) {
  return strip(html, ['script', 'style', 'svg', 'noscript'])
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ') // like a browser: re-wrapping a source line must not change the text
    .replace(/<\/(p|li|h[1-6]|tr|div|section|summary|figcaption|dt|dd|title)>|<br\s*\/?>/gi, '\n')
    .replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => decode(e, whole))
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
    .replace(/\d[\d,.]*[kM]?/g, 'N');
}

/** @param {string} want @param {string} got @returns {string} empty when equal */
function firstDiff(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  let i = 0;
  while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
  if (i === Math.max(a.length, b.length)) return '';
  const cut = (/** @type {string|undefined} */ s) => (s === undefined ? '(end of text)' : s.slice(0, 70));
  return `first difference at line ${i + 1}: expected "${cut(a[i])}", got "${cut(b[i])}"`;
}

/** @param {{slug: string, html: string}[]} pages */
function syncSnapshots(pages) {
  mkdirSync(SNAP, { recursive: true });
  for (const p of pages) writeFileSync(join(SNAP, `${p.slug}.txt`), `${visibleText(p.html)}\n`);
  const slugs = new Set(pages.map((p) => `${p.slug}.txt`));
  readdirSync(SNAP).filter((n) => n.endsWith('.txt') && !slugs.has(n)).forEach((n) => unlinkSync(join(SNAP, n)));
}

/** @param {{slug: string, html: string}[]} pages */
function compareSnapshots(pages) {
  for (const { slug, html } of pages) {
    const file = join(SNAP, `${slug}.txt`);
    if (!existsSync(file)) { fail(`${slug}: no text snapshot. ${TEXT_FIX}`); continue; }
    const diff = firstDiff(readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, ''), visibleText(html));
    if (diff) fail(`${slug}: visible text changed (${diff}). ${TEXT_FIX}`);
  }
}

function main() {
  if (!existsSync(DIST)) { console.error('[check-build] FAIL dist/ is missing. Fix: run "astro build" first.'); process.exit(1); }
  const pages = readPages();
  for (const { slug, html } of pages) {
    const glued = gluedSnippets(html);
    if (glued.length) fail(`${slug}: ${glued.length} inline tags glued to a word, e.g. "${glued[0]}". Fix: put the tag on the same source line as the word, or keep compressHTML: true in astro.config.mjs.`);
    duplicateIds(html).forEach((id) => fail(`${slug}: id="${id}" appears twice on the page. Fix: give each element a unique id.`));
  }
  const hexes = designHexes();
  unusedHexes(hexes).forEach((h) => fail(`DESIGN.md: ${h} is in the front matter but nowhere in src/ or scripts/. Fix: correct DESIGN.md or the code.`));
  if (UPDATE) syncSnapshots(pages); else compareSnapshots(pages);
  if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
  const tail = UPDATE ? `wrote ${pages.length} text snapshots` : 'text matches snapshot';
  console.log(`[check-build] OK: ${pages.length} pages, 0 glued inline tags, 0 duplicate ids, ${hexes.length} design hexes found, ${tail}`);
}

main();
