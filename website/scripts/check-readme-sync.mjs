#!/usr/bin/env node
// README <-> site drift guard. The site reads the comparison table and the FAQ out of README.md at build,
// so here they only have to parse; the checks after that cover copy that is still hand-written.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mdText, parseComparison, parseFaq } from '../src/content/readme-parse.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const normalize = (s) => s.replace(/\\/g, '').replace(/\s+/g, ' ').trim();

const readme = await readFile(join(root, '..', 'README.md'), 'utf8');
const site = await readFile(join(root, 'src', 'content', 'site.ts'), 'utf8');
const missing = [];

let parsed = '';
try {
  const readmeLf = readme.replace(/\r\n/g, '\n');
  const { systems, rows } = parseComparison(readmeLf);
  const faq = parseFaq(readmeLf);
  parsed = `${systems.length} systems x ${rows.length} comparison rows, ${faq.length} FAQ answers`;
  // FAQPage JSON-LD carries these answers as plain text, so no markdown may survive mdText.
  for (const { q, a } of faq) {
    if (/`|\]\(|\*\*|__/.test(mdText(a))) missing.push(`faq: markdown left in the JSON-LD answer to "${q}"`);
  }
} catch (err) {
  missing.push(`parse: ${err.message} (the site build reads this section)`);
}

// The test figure lives once in site.ts; the README and llms.txt must carry the same one.
const testsFloor = (site.match(/^\s*tests:\s*'([^']+)'/m) || [])[1];
const llms = await readFile(join(root, 'public', 'llms.txt'), 'utf8');
if (!testsFloor) {
  missing.push('tests: no `tests:` figure in site.ts');
} else {
  for (const [name, text] of [['README.md', readme], ['llms.txt', llms]]) {
    if (!text.includes(`${testsFloor} tests`)) missing.push(`tests: ${name} does not say "${testsFloor} tests"`);
  }
}

// Keep setup limits and commercial availability on the owning rendered surfaces.
for (const field of ['notice', 'availability']) {
  const value = (site.match(new RegExp(`^\\s*${field}:\\s*'([^']+)'`, 'm')) || [])[1];
  if (!value) {
    missing.push(`${field}: no shared copy in site.ts`);
  } else {
    for (const [name, text] of [['README.md', readme], ['llms.txt', llms]]) {
      if (!normalize(text).includes(normalize(value))) missing.push(`${field}: ${name} lost the shared wording`);
    }
  }
}
const home = await readFile(join(root, 'src', 'pages', 'index.astro'), 'utf8');
const quickstart = await readFile(join(root, 'src', 'pages', 'quickstart.astro'), 'utf8');
const teams = await readFile(join(root, 'src', 'pages', 'teams.astro'), 'utf8');
const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
if (!withoutComments(quickstart).includes('{getStarted.notice}')) missing.push('notice: quickstart.astro no longer renders the setup limit');
if (!withoutComments(teams).includes('{enterprise.availability}')) missing.push('availability: teams.astro no longer renders the edition status');

// Public copy states results, not limits; limits stay in the result docs (owner rule, 22 Nov 2026).
const limitLines = /lesson capture switched off|capture removed|no measured result|can't yet say|where hippo lost|hippo trails/i;
for (const [name, text] of [['home', withoutComments(home)], ['README.md', readme], ['llms.txt', llms]]) {
  if (limitLines.test(text)) missing.push(`limits: ${name} carries a limit line; state the result instead`);
}

// gbrain is never named on the site, in the README or in llms.txt (owner rule, 18 Nov 2026).
for (const [name, text] of [['README.md', readme], ['llms.txt', llms]]) {
  if (/gbrain/i.test(text)) missing.push(`gbrain: ${name} names it; take it out`);
}

if (missing.length) {
  console.error('[readme-sync] DRIFT: website copy no longer matches README.md:');
  for (const m of missing) console.error('  - ' + m);
  console.error('Fix: the README is the source of truth - update README.md and the site together.');
  process.exit(1);
}

console.log(`[readme-sync] OK: parsed ${parsed}; tests floor "${testsFloor}", setup limits and edition availability match README.md.`);
