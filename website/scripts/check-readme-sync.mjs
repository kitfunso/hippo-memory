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
const setup = await readFile(join(root, 'src', 'components', 'GetStarted.astro'), 'utf8');
const quickstart = await readFile(join(root, 'src', 'pages', 'quickstart.astro'), 'utf8');
const teams = await readFile(join(root, 'src', 'pages', 'teams.astro'), 'utf8');
const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
if (!withoutComments(setup).includes('{getStarted.notice}')) missing.push('notice: GetStarted.astro no longer renders the setup limit');
if (!withoutComments(quickstart).includes('{getStarted.notice}')) missing.push('notice: quickstart.astro no longer renders the setup limit');
if (!withoutComments(teams).includes('{enterprise.availability}')) missing.push('availability: teams.astro no longer renders the edition status');

// A loss line that links a committed score file may only quote numbers that file holds.
const scoreFiles = Object.fromEntries(
  [...site.matchAll(/^\s*(\w+):\s*`\$\{REPO\}\/blob\/master\/(benchmarks\/public\/results\/[^`]+\.(?:txt|json))`/gm)].map((m) => [m[1], m[2]]),
);
let lossLines = 0;
for (const [, , text, key] of site.matchAll(/\{\s*text:\s*(["'])((?:(?!\1).)*)\1,\s*href:\s*site\.links\.(\w+)\s*\}/g)) {
  if (!scoreFiles[key]) continue;
  lossLines++;
  const held = await readFile(join(root, '..', scoreFiles[key]), 'utf8');
  for (const n of text.match(/\d+\.\d+/g) ?? []) {
    if (!held.includes(n)) missing.push(`losses: "${n}" is not in ${scoreFiles[key]}`);
  }
}
if (!lossLines) missing.push('losses: no loss line links a committed score file');

// A hero proof that links a committed results file may only quote numbers that file holds (commas dropped).
// Comments are stripped first so a number or caveat parked in a code comment cannot satisfy a check.
const hero = await readFile(join(root, 'src', 'components', 'Hero.astro'), 'utf8');
const proofsRaw = (site.match(/export const proofs\s*(?::[^=]+)?=\s*\[([\s\S]*?)\n\][^\n]*;/) || [])[1] || '';
const proofsBlock = proofsRaw.replace(/\/\/[^\n]*/g, '');
const noCommas = (t) => t.replace(/(\d),(\d{3})/g, '$1$2');
let proofLines = 0;
if (!proofsRaw) {
  missing.push('proofs: block not found in site.ts (the hero renders it)');
} else {
  const proofRe = /stat:\s*(["'])((?:(?!\1).)*)\1,\s*text:\s*(["'])((?:(?!\3).)*)\3,\s*href:\s*site\.links\.(\w+)/g;
  for (const [, , stat, , text, key] of proofsBlock.matchAll(proofRe)) {
    if (!scoreFiles[key]) continue;
    proofLines++;
    const held = noCommas(await readFile(join(root, '..', scoreFiles[key]), 'utf8'));
    for (const n of noCommas(`${stat} ${text}`).match(/\d+\.\d+|\d{3,}/g) ?? []) {
      if (!held.includes(n)) missing.push(`proofs: "${n}" is not in ${scoreFiles[key]}`);
    }
  }
  if (!proofLines) missing.push('proofs: no hero proof links a committed results file');
}
if (!/proofs\.map\(/.test(hero) || !/p\.text/.test(hero)) {
  missing.push('proofs: Hero.astro no longer renders each proof with its text');
}

// The Z0 win never travels without its caveat, and the home shows the losses under the public tests.
const testBlock = ((site.match(/export const theTest = \{([\s\S]*?)\n\} as const;/) || [])[1] || '').replace(/\/\/[^\n]*/g, '');
if (!/lesson capture/.test(testBlock)) missing.push('theTest: the Z0 result lost its lesson-capture caveat');
const theTestCmp = await readFile(join(root, 'src', 'components', 'TheTest.astro'), 'utf8');
if (!withoutComments(theTestCmp).includes('theTest.note')) missing.push('theTest: TheTest.astro no longer renders the caveat');
const homeBench = await readFile(join(root, 'src', 'components', 'HomeBench.astro'), 'utf8');
if (!/losses\.items/.test(withoutComments(homeBench))) missing.push('losses: HomeBench.astro no longer shows the losses');

if (missing.length) {
  console.error('[readme-sync] DRIFT: website copy no longer matches README.md:');
  for (const m of missing) console.error('  - ' + m);
  console.error('Fix: the README is the source of truth - update README.md and the site together.');
  process.exit(1);
}

console.log(`[readme-sync] OK: parsed ${parsed}; tests floor "${testsFloor}", ${lossLines} loss lines and ${proofLines} hero proofs match their files, setup limits and edition availability match README.md.`);
