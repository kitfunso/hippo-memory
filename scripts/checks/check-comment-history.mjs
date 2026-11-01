#!/usr/bin/env node
// CI comment gate. A src/ comment line carrying a ticket code, version tag, reviewer note, date, plan path or
// section number fails, as does a one-word comment line or doc ending; the history belongs in docs or the git log.
// Usage: check-comment-history.mjs [--list [file...]].

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Each pattern skips domain words it would otherwise hit: schema versions (v39, not a release tag), DAG layers L0-L3,
// markdown headers H1-H6, BM25, FTS5, SHA1, UTF8, P95 percentiles, a prereg "amendment A1", invalid example dates,
// and the Codex product.
const PATTERNS = [
  ['version', /\bv\d+\.\d+(?:\.\d+)?\b/],
  [
    'ticket',
    /\b(?!(?:BM25|FTS5|FP32|NAT64|C0|H[1-6]|MD5|X509|V\d|SHA\d|UTF\d|IPV\d|HTTP\d|P\d\d|L[0-3])\b)(?<!amendment )[A-Z]{1,4}\d{1,2}(?:\.\d+)?\b/,
  ],
  [
    'review',
    /\b[Cc]odex[- ](?:[Rr]eview|[Rr]ound|P\d|R\d|catch|finding|flagged|CRITICAL|diff-pass)|\([Cc]odex\b|\b[Cc]odex\)|\b[Cc]ritic\b|\bsenior-review\b|\b[Rr]ound[- ]?\d+\b|\bCRIT\b|\bP[0-3]s?\b/,
  ],
  ['plan', /docs\/plans\/|\bplan v\d|\bTask \d/],
  ['date', /\b(?!\d{4}-02-3[01]\b|20(?:[02468][1235679]|[13579][01345789])-02-29\b)20\d\d-\d\d-\d\d\b/],
  ['pr', /\(#\d{2,4}\)|\bPR ?#?\d+|\bissue #\d+/],
];

// Section labels that name a plan, wave or feature number instead of what the code is; no baseline, any hit fails.
const LABEL_PATTERN = /\bFeature \d+:|\bW\d+[a-z]?:|\b[Pp]lan designs? \d+|\bCHANGELOG \d/;
// A wrapped `//` comment's last word left alone on its line; any hit fails.
const ONE_WORD = /^ [A-Za-z]+\.?\r?$/;
// Paths the concurrent tail lane edits keep their one-word lines until it lands, so either merge order passes.
const ORPHAN_PENDING = [
  'src/base/memory/',
  'src/api/recall/anchoring.ts',
  'src/base/ports/infra.ts',
  'src/base/util/env.ts',
  'src/entry/eval.ts',
  'src/infra/eval-switches.ts',
  'src/infra/ports.ts',
  'src/store/sqlite/entries/entry-writes.ts',
  'src/store/sqlite/folder-files/mirrors.ts',
  'src/store/sqlite/runtime/handles.ts',
  'src/store/sqlite/runtime/open.ts',
  'src/surface/cli/eval.ts',
];

const PRECEDES_REGEX = '(,=:[!&|?{};+-*%<>~^';

/** Index just past the string literal that opens at `start`, and how many escaped newlines it spans. */
function skipQuoted(src, start, quote) {
  let i = start + 1;
  let newlines = 0;
  while (i < src.length && src[i] !== quote && src[i] !== '\n') {
    if (src[i] === '\\' && src[i + 1] === '\n') newlines++;
    i += src[i] === '\\' ? 2 : 1;
  }
  return { next: i + 1, newlines };
}

/** Index just past the regex literal that opens at `start`. */
function skipRegexLiteral(src, start) {
  let inClass = false;
  let i = start + 1;
  while (i < src.length && src[i] !== '\n' && (src[i] !== '/' || inClass)) {
    if (src[i] === '\\') i++;
    else if (src[i] === '[') inClass = true;
    else if (src[i] === ']') inClass = false;
    i++;
  }
  return i + 1;
}

function opensRegex(src, i, prev) {
  if (prev === '' || PRECEDES_REGEX.includes(prev)) return true;
  return /(?:^|[^\w$])(?:return|typeof|case)\s*$/.test(src.slice(Math.max(0, i - 8), i));
}

/** Returns [lineNumber, text, ownLine, endsDoc] for every comment line: `//` tails and each line of a block comment.
 * ownLine is true for a `//` comment with only space before it on its line; endsDoc for a block's last line of prose
 * when an earlier line holds prose too. */
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
      out.push([line, src.slice(i + 2, stop), /^\s*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i)), false]);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end;
      const parts = src.slice(i + 2, stop).split('\n');
      const prose = proseLines(parts);
      const last = prose.length > 1 ? prose[prose.length - 1] : -1;
      parts.forEach((part, k) => out.push([line + k, part, false, k === last]));
      line += parts.length - 1;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const skipped = skipQuoted(src, i, c);
      i = skipped.next;
      line += skipped.newlines;
      prev = c;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i++;
      continue;
    }
    if (c === '/' && opensRegex(src, i, prev)) {
      i = skipRegexLiteral(src, i);
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

/** A block comment line's words, past its leading `*`s. */
function docText(part) {
  return part.replace(/^\s*\*+/, '').trim();
}

/** Indexes of a block's prose lines: a code fence's lines are code, and a JSDoc tag such as `@internal` holds the
 * rest of the block, so a lone fence or tag never reads as a wrapped word. */
function proseLines(parts) {
  const out = [];
  let fenced = false;
  for (const [k, part] of parts.entries()) {
    const text = docText(part);
    if (text.startsWith('```')) fenced = !fenced;
    else if (fenced || text === '') continue;
    else if (text.startsWith('@')) break;
    else out.push(k);
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
    const src = readFileSync(file, 'utf8');
    const pending = ORPHAN_PENDING.some((p) => file.startsWith(p));
    for (const [line, text, ownLine, endsDoc] of commentLines(src)) {
      const kind = LABEL_PATTERN.test(text) ? 'label' : PATTERNS.find(([, re]) => re.test(text))?.[0];
      if (kind) hits.push({ file, line, kind, text: text.trim() });
      const orphan = (ownLine && ONE_WORD.test(text)) || (endsDoc && /^\S+$/.test(docText(text)));
      if (orphan && !pending) hits.push({ file, line, kind: 'orphan', text: (ownLine ? `//${text}` : text).trim() });
    }
  }
  return hits;
}

const HEADERS = {
  history:
    'Comment lines carrying ticket codes, versions, reviewer notes, dates or plan paths (say why in one line; the history goes to docs or the commit message):',
  label: 'Comments that label a section with a feature, wave or plan number (say what the code is):',
  orphan: 'Comment lines holding one word (rejoin it to the line above):',
};
const hits = findHits();
const args = process.argv.slice(2);

if (args.includes('--list')) {
  const only = args.filter((a) => a !== '--list');
  for (const h of hits) {
    if (only.length === 0 || only.includes(h.file)) console.log(`${h.file}:${h.line} [${h.kind}] ${h.text}`);
  }
  process.exit(0);
}

if (hits.length > 0) {
  for (const [group, header] of Object.entries(HEADERS)) {
    const found = hits.filter((h) => (h.kind in HEADERS ? h.kind : 'history') === group);
    if (found.length > 0) console.error(header);
    for (const h of found) console.error(`  ${h.file}:${h.line} ${h.text}`);
  }
  process.exit(1);
}
console.log('Comment history check OK: no history, section labels or one-word lines in src comments.');
