#!/usr/bin/env node
// CI gate: no src/ line over 120 characters. oxfmt wraps code but not strings or comments, and oxlint
// has no line-length rule; files in .long-lines-baseline.json may lose long lines, never gain one.
// Usage: check-long-lines.mjs [--update]. --update rewrites the baseline after long lines go.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = '.long-lines-baseline.json';
const LINE_LIMIT = 120;

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Lines longer than LINE_LIMIT characters; a trailing CR is not counted. */
function longLineCount(text) {
  return text.split('\n').filter((l) => l.replace(/\r$/, '').length > LINE_LIMIT).length;
}

/** { path: count } of every src file with a long line, keys sorted. */
function findLongLines() {
  const out = {};
  for (const file of existsSync('src') ? tsFiles('src') : []) {
    const n = longLineCount(readFileSync(file, 'utf8'));
    if (n > 0) out[file] = n;
  }
  return out;
}

const current = findLongLines();
const total = Object.values(current).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total} src lines over ${LINE_LIMIT} characters.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const rose = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0));
const fell = Object.entries(baseline).filter(([file, n]) => (current[file] ?? 0) < n);

if (rose.length > 0) {
  console.error(`src lines over ${LINE_LIMIT} characters appeared or grew past ${BASELINE}:`);
  for (const [file, n] of rose) console.error(`  ${file}: ${baseline[file] ?? 'new'} -> ${n}`);
  console.error('Wrap the comment or string, or move the text into a named constant.');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(
    `${fell.length} files lost long lines; run \`node scripts/checks/check-long-lines.mjs --update\` to lock that in.`,
  );
}
console.log(`Long lines OK: ${total} src lines over ${LINE_LIMIT} characters, none above ${BASELINE}.`);
