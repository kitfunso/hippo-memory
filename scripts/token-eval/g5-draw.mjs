// Z0 G5 (prereg 166, 179): seeded stratified draws, path redaction, the leak scan, label files and the agreement statistics.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from './regrade.mjs';
import { READER_HIDDEN } from './workspace.mjs';
import { ALL_ARMS } from './z0-records.mjs';

const win = process.platform === 'win32';
const Z95 = 1.959963984540054;
// The memory tool, its homes and every instruction or memory file the reader diff hides: a command naming one is dropped.
const HIDDEN_WORDS = ['hippo', 'memory/', 'claude-config', 'codex-home', ...READER_HIDDEN];
// Strings that name a memory tool, a home or a hidden marker: any of them left in a blinded file could show the arm.
export const FORBIDDEN = [...HIDDEN_WORDS, '.hippo', 'hippo-home', '[command hidden]', '[tool]'];
export const isHiddenCommand = (command) => leakScan(command, HIDDEN_WORDS).length > 0;
// An arm or seed named as its own word shows the arm as plainly as a path; arms keep their case, so code like x1 survives.
const ARM_WORD = new RegExp(`\\b(?:${ALL_ARMS.join('|')})\\b`, 'g');
const SEED_WORD = /\bseed\d+\b/gi;

/** Items in sha256(`${seed}:${salt}${id}`) order: a pure function of the seed and the set, never of the listing order. */
export function seededOrder(seed, items, idOf = (x) => x, salt = '') {
  const keyed = items.map((x) => [sha256(`${seed}:${salt}${idOf(x)}`), idOf(x), x]);
  return keyed.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))).map((k) => k[2]);
}

/** Largest-remainder shares of `total` in proportion to `counts`, ties broken in seeded order (R18). */
export function proportional(seed, total, counts, salt) {
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  const shares = new Map([...counts].map(([k, c]) => [k, sum === 0 ? 0 : Math.floor((total * c) / sum)]));
  if (sum === 0) return shares;
  let left = Math.min(total, sum) - [...shares.values()].reduce((a, b) => a + b, 0);
  const rem = (k) => (total * counts.get(k)) / sum - shares.get(k);
  const order = seededOrder(seed, [...counts.keys()], (k) => k, salt).sort((a, b) => rem(b) - rem(a));
  for (const k of order) {
    if (left <= 0) break;
    if (shares.get(k) < counts.get(k)) {
      shares.set(k, shares.get(k) + 1);
      left--;
    }
  }
  return shares;
}

/** Equal shares per group, the remainder to groups in seeded order (reading 11). */
export function equalShares(seed, n, groups) {
  const order = seededOrder(seed, groups, (g) => g, 'arm:');
  return new Map(order.map((g, i) => [g, Math.floor(n / groups.length) + (i < n % groups.length ? 1 : 0)]));
}

function cursor(items, accept, rejected) {
  let i = 0;
  return () => {
    while (i < items.length) {
      const x = items[i++];
      if (accept(x)) return x;
      rejected.push(x);
    }
    return null;
  };
}

/** Fill each stratum to its quota with accepted items; a shortfall moves to the group's other strata, then round-robin to other groups. */
export function fillStrata(groups, n, accept) {
  const rejected = [];
  const taken = [];
  const all = groups.map((g) => ({ ...g, strata: g.strata.map((s) => ({ ...s, next: cursor(s.items, accept, rejected) })) }));
  const take = (s) => {
    const x = s.next();
    if (x !== null) taken.push(x);
    return x !== null;
  };
  for (const g of all) {
    g.got = 0;
    for (const s of g.strata) for (let k = 0; k < s.quota && take(s); k++) g.got++;
    for (const s of g.strata) while (g.got < g.share && take(s)) g.got++;
  }
  let progress = true;
  while (taken.length < n && progress) {
    progress = false;
    for (const g of all) {
      if (taken.length >= n) break;
      if (g.strata.some((s) => take(s))) progress = true;
    }
  }
  return { taken, rejected };
}

/** Windows 8.3 short name of an existing path, or null where the volume keeps none (R14). */
function shortName(p) {
  if (!win || !fs.existsSync(p)) return null;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const s = r.status === 0 ? r.stdout.trim() : '';
  return s && s !== p ? s : null;
}

function spellings(base) {
  const fwd = base.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  const out = [base, fwd, base.replace(/\\/g, '\\\\')];
  if (drive) for (const pre of ['/', '/mnt/', '/cygdrive/']) out.push(`${pre}${drive[1].toLowerCase()}/${drive[2]}`);
  // The Claude Code project folder is the session cwd with every non-alphanumeric turned into `-`.
  out.push(base.replace(/[^a-zA-Z0-9]/g, '-'));
  return out;
}

/** A function that turns every spelling of each root into `<run>`: given, resolved, realpath, 8.3, slash and shell forms. */
export function redactor(roots) {
  const forms = new Set();
  for (const r of roots) {
    const bases = [r, path.resolve(r)];
    if (fs.existsSync(r)) bases.push(fs.realpathSync(r), fs.realpathSync.native(r), shortName(fs.realpathSync.native(r)));
    for (const b of bases.filter(Boolean)) for (const s of spellings(b.replace(/[\\/]+$/, ''))) if (s.length > 3) forms.add(s);
  }
  const sorted = [...forms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (sorted.length === 0) return (text) => text;
  const re = new RegExp(sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), win ? 'gi' : 'g');
  return (text) => text.replace(re, '<run>');
}

/** The forbidden strings a blinded text still holds, case-folded; slashes are compared in both directions. */
export function leakScan(text, forbidden) {
  const folded = text.toLowerCase().replace(/\\/g, '/');
  return forbidden.filter((f) => folded.includes(f.toLowerCase().replace(/\\/g, '/')));
}

/** The forbidden strings, then the standalone arm and seed words, a blinded text still holds. */
export const blindLeaks = (text, forbidden) => [...leakScan(text, forbidden), ...(text.match(ARM_WORD) ?? []), ...(text.match(SEED_WORD) ?? [])];

/** A label TSV (`id<TAB>label<TAB>note`): BOM, CRLF, `#` lines and blank lines accepted; any other fault names its line. */
export function parseLabels(text, ids, allowed) {
  const want = new Set(ids);
  const labels = new Map();
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const [id, label = ''] = line.split('\t').map((c) => c.trim());
    const at = `labels line ${i + 1}`;
    if (!want.has(id)) throw new Error(`${at}: unknown id ${id}`);
    if (labels.has(id)) throw new Error(`${at}: ${id} is labelled twice`);
    if (!allowed.includes(label)) throw new Error(`${at}: label "${label}" for ${id} is not one of ${allowed.join(', ')}`);
    labels.set(id, label);
  });
  const missing = ids.filter((id) => !labels.has(id));
  if (missing.length) throw new Error(`labels: no label for ${missing.join(', ')}`);
  return labels;
}

/** The Wilson 95% interval for k of n, or null for an empty sample. */
export function wilson(k, n) {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (Z95 * Z95) / n;
  const c = (p + (Z95 * Z95) / (2 * n)) / d;
  const h = (Z95 * Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n))) / d;
  // Rounding can push an endpoint a hair outside [0, 1], where the analyzer's bounds check rejects it.
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Cohen's kappa on a 2x2 table (first word the judgement, second the label); null when chance agreement is 1. */
export function kappa({ yesYes, yesNo, noYes, noNo }) {
  const n = yesYes + yesNo + noYes + noNo;
  if (n === 0) return null;
  const po = (yesYes + noNo) / n;
  const pe = ((yesYes + yesNo) * (yesYes + noYes) + (noYes + noNo) * (yesNo + noNo)) / (n * n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** A fence longer than any backtick run in the text, so a diff can never close its own block. */
export function fenced(text, lang = '') {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text.endsWith('\n') ? text : `${text}\n`}${fence}\n`;
}

/** A labels.tsv template: one `#` header line, then one row per file id. */
export const labelsTemplate = (ids, allowed) => `# id\tlabel (${allowed.join('|')})\tnote\n${ids.map((id) => `${id}\t\t\n`).join('')}`;
