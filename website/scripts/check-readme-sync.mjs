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
const readmeNorm = normalize(readme);
const missing = [];

let parsed = '';
try {
  const readmeLf = readme.replace(/\r\n/g, '\n');
  const { systems, rows, bets } = parseComparison(readmeLf);
  const faq = parseFaq(readmeLf);
  parsed = `${systems.length} systems x ${rows.length} fact rows and ${bets.length} design-bet rows, ${faq.length} FAQ answers`;
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
if (!testsFloor) missing.push('tests: no `tests:` figure in site.ts');
else for (const [name, text] of [['README.md', readme], ['llms.txt', llms]]) {
  if (!text.includes(`${testsFloor} tests`)) missing.push(`tests: ${name} does not say "${testsFloor} tests"`);
}

const warns = ['R@5 = 74.0%', '0 outbound HTTP'].filter((c) => !readmeNorm.includes(normalize(c)));
if (warns.length) {
  console.warn('[readme-sync] WARN: receipt claim(s) not found verbatim in README (verify wording):', warns.join(' | '));
}

// LoCoMo rows on the benchmarks page must match the README's "### LoCoMo" subsection row for
// row (category, n and r5 on one table line), so a swapped or copied score cannot pass.
const bench = await readFile(join(root, 'src', 'pages', 'benchmarks.astro'), 'utf8');
const locoStart = readme.indexOf('### LoCoMo');
const locoEnd = locoStart >= 0 ? readme.indexOf('\n### ', locoStart + 3) : -1;
const locoNorm = normalize(locoStart >= 0 ? readme.slice(locoStart, locoEnd > 0 ? locoEnd : undefined) : '').replace(/\*/g, '');
const locoBlock = (bench.match(/const locomo = \[([\s\S]*?)\];/) || [])[1] || '';
const locoRows = [...locoBlock.matchAll(/\{\s*category:\s*'([^']*)',\s*n:\s*'([^']*)',\s*r5:\s*'([^']*)'\s*\}/g)];
if (!locoRows.length) missing.push('locomo: no rows found in benchmarks.astro');
for (const [, category, n, r5] of locoRows) {
  if (!locoNorm.includes(`| ${category} | ${n} | ${r5} |`)) missing.push(`locomo row: | ${category} | ${n} | ${r5} |`);
}

// Presence anywhere on the site is not the check: the reranker result has to reach the
// hero, and it never travels without the negative result that bounds it.
// Comments are stripped first so a caveat parked in a code comment cannot satisfy it.
const hero = await readFile(join(root, 'src', 'components', 'Hero.astro'), 'utf8');
const proofsRaw = (site.match(/export const proofs\s*(?::[^=]+)?=\s*\[([\s\S]*?)\n\][^\n]*;/) || [])[1] || '';
const proofsBlock = proofsRaw.replace(/\/\/[^\n]*/g, '');
if (!proofsRaw) {
  missing.push('proofs: block not found in site.ts (the hero renders it)');
} else {
  if (!/reranker/i.test(proofsBlock)) missing.push('proofs: the hero carries no reranker claim');
  if (!/no answer-rate win was shown/.test(proofsBlock)) {
    missing.push('proofs: the reranker claim lost its null result');
  }
}
if (!/proofs\.map\(/.test(hero) || !/p\.text/.test(hero)) {
  missing.push('proofs: Hero.astro no longer renders each proof with its text');
}

if (missing.length) {
  console.error('[readme-sync] DRIFT: website copy no longer matches README.md:');
  for (const m of missing) console.error('  - ' + m);
  console.error('Fix: the README is the source of truth - update README.md and the site together.');
  process.exit(1);
}

console.log(`[readme-sync] OK: parsed ${parsed}; tests floor "${testsFloor}", ${locoRows.length} LoCoMo rows and the hero proofs match README.md.`);
