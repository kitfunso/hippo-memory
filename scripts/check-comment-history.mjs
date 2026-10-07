#!/usr/bin/env node
// CI comment gate. Ticket codes, version tags, reviewer notes, dates and plan paths in src/ comments belong in docs
// or git log; each file's count of such comment lines may fall but never rise above .comment-history-baseline.json.
// Usage: check-comment-history.mjs [--list [file...]] [--update]. --update rewrites the baseline; run it only after clearing hits.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = '.comment-history-baseline.json';

// Each pattern skips domain words it would otherwise hit: schema versions (v39, not a release tag), DAG layers L0-L3,
// BM25, FTS5, SHA1, UTF8, P95 percentiles, a prereg "amendment A1", invalid example dates, and the Codex product.
const PATTERNS = [
  ['version', /\bv\d+\.\d+(?:\.\d+)?\b/],
  ['ticket', /\b(?!(?:BM25|FTS5|FP32|NAT64|C0|H1|MD5|X509|V\d|SHA\d|UTF\d|IPV\d|HTTP\d|P\d\d|L[0-3])\b)(?<!amendment )[A-Z]{1,4}\d{1,2}(?:\.\d+)?\b/],
  ['review', /\b[Cc]odex[- ](?:[Rr]eview|[Rr]ound|P\d|R\d|catch|finding|flagged|CRITICAL|diff-pass)|\([Cc]odex\b|\b[Cc]odex\)|\b[Cc]ritic\b|\bsenior-review\b|\b[Rr]ound[- ]?\d+\b|\bCRIT\b|\bP[0-3]s?\b/],
  ['plan', /docs\/plans\/|\bplan v\d|\bTask \d/],
  ['date', /\b(?!\d{4}-02-3[01]\b|20(?:[02468][1235679]|[13579][01345789])-02-29\b)20\d\d-\d\d-\d\d\b/],
  ['pr', /\(#\d{2,4}\)|\bPR ?#?\d+|\bissue #\d+/],
];

const PRECEDES_REGEX = '(,=:[!&|?{};+-*%<>~^';

/** Returns [lineNumber, text] for every comment line: `//` tails and each line of a block comment. */
function commentLines(src) {
  const out = [];
  const templateDepth = []; // brace depth inside each open `${ }`
  let line = 1;
  let i = 0;
  let prev = ''; // last code char; decides whether `/` opens a regex or divides
  let inTemplate = false;
  while (i < src.length) {
    const c = src[i];
    if (inTemplate) {
      if (c === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (c === '`') inTemplate = false;
      else if (c === '$' && src[i + 1] === '{') {
        templateDepth.push(0);
        inTemplate = false;
        i++;
      } else if (c === '\n') line++;
      i++;
      continue;
    }
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out.push([line, src.slice(i + 2, stop)]);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end;
      const parts = src.slice(i + 2, stop).split('\n');
      parts.forEach((part, k) => out.push([line + k, part]));
      line += parts.length - 1;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') line++;
        i += src[i] === '\\' ? 2 : 1;
      }
      i++;
      prev = c;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i++;
      continue;
    }
    if (c === '/' && (prev === '' || PRECEDES_REGEX.includes(prev) || /(?:^|[^\w$])(?:return|typeof|case)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let inClass = false;
      i++;
      while (i < src.length && src[i] !== '\n' && (src[i] !== '/' || inClass)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      i++;
      prev = ')';
      continue;
    }
    if (c === '{' && templateDepth.length > 0) templateDepth[templateDepth.length - 1]++;
    else if (c === '}' && templateDepth.length > 0) {
      if (templateDepth[templateDepth.length - 1] === 0) {
        templateDepth.pop();
        inTemplate = true;
        i++;
        continue;
      }
      templateDepth[templateDepth.length - 1]--;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name)) out.push(p.replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Every history-carrying comment line under src/: { file, line, kind, text }. */
function findHits() {
  const hits = [];
  for (const file of existsSync('src') ? tsFiles('src') : []) {
    for (const [line, text] of commentLines(readFileSync(file, 'utf8'))) {
      const kind = PATTERNS.find(([, re]) => re.test(text))?.[0];
      if (kind) hits.push({ file, line, kind, text: text.trim() });
    }
  }
  return hits;
}

const hits = findHits();
const counts = {};
for (const h of hits) counts[h.file] = (counts[h.file] ?? 0) + 1;
const args = process.argv.slice(2);

if (args.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${hits.length} lines over ${Object.keys(counts).length} files.`);
  process.exit(0);
}

if (args.includes('--list')) {
  const only = args.filter((a) => a !== '--list');
  for (const h of hits) {
    if (only.length === 0 || only.includes(h.file)) console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`);
  }
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const rose = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0));
const fell = Object.entries(baseline).filter(([file, n]) => (counts[file] ?? 0) < n);

if (rose.length > 0) {
  console.error('Comment lines carrying ticket codes, versions, reviewer notes, dates or plan paths rose above the baseline:');
  for (const [file, n] of rose) console.error(`  ${file}: ${baseline[file] ?? 0} -> ${n}`);
  console.error('Say why in one line and move the history to docs or the commit message.');
  console.error('`node scripts/check-comment-history.mjs --list <file>` shows the matching lines.');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(`${fell.length} files fell below the baseline; run \`node scripts/check-comment-history.mjs --update\` to lock that in.`);
}
console.log(`Comment history ratchet OK: ${hits.length} lines, none above ${BASELINE}.`);
