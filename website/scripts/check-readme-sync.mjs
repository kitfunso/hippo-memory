#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mdText, parseComparison, parseFaq } from '../src/content/readme-parse.mjs';
import { withPublicTests } from './readme-public-tests.mjs';

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
  for (const { q, a } of faq) {
    if (/`|\]\(|\*\*|__/.test(mdText(a))) missing.push(`faq: markdown left in the JSON-LD answer to "${q}"`);
  }
} catch (err) {
  missing.push(`parse: ${err.message} (the site build reads this section)`);
}

const testsFloor = (site.match(/^\s*tests:\s*'([^']+)'/m) || [])[1];
const llms = await readFile(join(root, 'public', 'llms.txt'), 'utf8');
if (!testsFloor) {
  missing.push('tests: no `tests:` figure in site.ts');
} else {
  for (const [name, text] of [['README.md', readme], ['llms.txt', llms]]) {
    if (!text.includes(`${testsFloor} tests`)) missing.push(`tests: ${name} does not say "${testsFloor} tests"`);
  }
}

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

const limitLines = /lesson capture switched off|capture removed|no measured result|can't yet say|where hippo lost|hippo trails/i;
for (const [name, text] of [['home', withoutComments(home)], ['README.md', readme], ['llms.txt', llms]]) {
  if (limitLines.test(text)) missing.push(`limits: ${name} carries a limit line; state the result instead`);
}

const board = JSON.parse(await readFile(join(root, 'src', 'data', 'all-benchmarks.json'), 'utf8'));
try {
  const readmeLf = readme.replace(/\r\n/g, '\n');
  if (withPublicTests(readmeLf, board) !== readmeLf) {
    missing.push('public tests: README.md table differs from all-benchmarks.json; run node website/scripts/readme-public-tests.mjs --write');
  }
} catch (err) {
  missing.push(`public tests: ${err.message}`);
}

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
