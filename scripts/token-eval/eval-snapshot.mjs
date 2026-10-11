#!/usr/bin/env node
// Eval checkout for authors and runs (prereg 51, stage 2 plan D3): one commit of a source tree with its rule files removed and forbidden terms scrubbed.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORBID_SETS } from './z0-author.mjs';

// Agent-instruction and contributor files at any depth; the rule sources go to the author as withheld-line copies instead.
const RULE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'CONTRIBUTING.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md']);
const RULE_DIRS = new Set(['.cursor', '.claude']);
const IDENTITY = { GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
export const SCRUB_WORD = 'store';
export const WITHHELD = '[line withheld]';

const git = (args, opts = {}) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts }).trim();
const isRulePath = (rel) => { const parts = rel.split('/'); return RULE_NAMES.has(parts.at(-1)) || parts.some((p) => RULE_DIRS.has(p)); };
// Only rule sources (prereg 51) reach the author; settings and command files are removed but never copied.
const isRuleSource = (rel) => RULE_NAMES.has(rel.split('/').at(-1)) || /(^|\/)\.(cursor|claude)\/rules\//.test(rel);
// git's own test: a NUL byte in the first 8000 bytes marks a binary file.
const isText = (buf) => !buf.subarray(0, 8000).includes(0);

/** 1-based numbers of the rule lines to withhold: each forbidden line, and every line of a tool block whose start marker names a forbidden term. */
function withheldLines(lines, forbid) {
  // An installed tool's block (<!-- name:start --> to <!-- name:end -->) teaches its workflow on lines that never say its name.
  const hit = new Set();
  let end = null;
  lines.forEach((line, i) => {
    const start = line.match(/^\s*<!--\s*([\w-]+):start\s*-->/);
    if (!end && start?.[1].match(forbid)) end = new RegExp(`^\\s*<!--\\s*${start[1]}:end\\s*-->`);
    if (end || line.match(forbid)) hit.add(i + 1);
    if (end?.test(line)) end = null;
  });
  return hit;
}

/** Each earlier version of the copied rule sources, withheld the same way, so a reversal can come from a real rule change (D4). */
function writeHistory(source, full, files, rulesOut, forbid) {
  const index = [];
  for (const rel of files) {
    const current = fs.readFileSync(path.join(rulesOut, rel), 'utf8');
    // Dates and hashes only: commit subjects can name anything.
    for (const entry of git(['-C', source, 'log', '--diff-filter=d', '--format=%H %cs', full, '--', rel]).split('\n').filter(Boolean)) {
      const [commit, date] = entry.split(' ');
      // Untrimmed, so the copy's lines match lesson-sources' verbatim check.
      const lines = execFileSync('git', ['-C', source, 'show', `${commit}:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
      const hit = withheldLines(lines, forbid);
      const text = lines.map((l, i) => (hit.has(i + 1) ? WITHHELD : l)).join('\n');
      if (text === current || index.some((e) => e.file === rel && e.text === text)) continue;
      const copy = `history/${rel}/${date}-${commit.slice(0, 12)}${path.extname(rel)}`;
      fs.mkdirSync(path.dirname(path.join(rulesOut, copy)), { recursive: true });
      fs.writeFileSync(path.join(rulesOut, copy), text);
      index.push({ file: rel, commit, date, copy, text });
    }
  }
  const entries = index.map(({ text: _text, ...e }) => e);
  if (entries.length) fs.writeFileSync(path.join(rulesOut, 'history/index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((d) => {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.name === '.git' && !rel) return [];
    return d.isDirectory() ? listFiles(root, r) : [r];
  });
}

/** Write `commit` of `source` into the empty folder `out` as a one-commit repo; returns the manifest.
 * @param {{source: string, commit: string, out: string, forbidSet?: string, drop?: string[], rulesOut?: string | null}} opts
 * @returns {{source: string, commit: string, forbidSet: string, ruleFiles: string[], withheld: Record<string, number[]>, dropped: string[], scrubbed: Record<string, number>, binaryHits: string[], history?: {file: string, commit: string, date: string, copy: string}[], snapshotCommit: string}} */
export function buildSnapshot({ source, commit, out, forbidSet = 'default', drop = [], rulesOut = null }) {
  if (!Object.hasOwn(FORBID_SETS, forbidSet)) throw new Error(`unknown forbid set ${forbidSet}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  const forbid = new RegExp(FORBID_SETS[forbidSet], 'gi');
  const full = git(['-C', source, 'rev-parse', '--verify', `${commit}^{commit}`]);
  fs.mkdirSync(out, { recursive: true });
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(['-C', source, `--work-tree=${out}`, 'read-tree', full], { env });
  git(['-C', source, `--work-tree=${out}`, 'checkout-index', '-a', '-f'], { env });
  fs.rmSync(path.dirname(index), { recursive: true, force: true });

  const manifest = { source: path.resolve(source).replaceAll('\\', '/'), commit: full, forbidSet, ruleFiles: [], withheld: {}, dropped: [], scrubbed: {}, binaryHits: [] };
  for (const rel of listFiles(out)) {
    const abs = path.join(out, rel);
    const buf = fs.readFileSync(abs);
    if (isRulePath(rel)) {
      manifest.ruleFiles.push(rel);
      if (rulesOut && isRuleSource(rel) && isText(buf)) {
        const lines = buf.toString('utf8').split('\n');
        const hit = withheldLines(lines, forbid);
        if (hit.size) manifest.withheld[rel] = [...hit];
        fs.mkdirSync(path.dirname(path.join(rulesOut, rel)), { recursive: true });
        fs.writeFileSync(path.join(rulesOut, rel), lines.map((l, i) => (hit.has(i + 1) ? WITHHELD : l)).join('\n'));
      }
      fs.rmSync(abs);
    } else if (drop.some((d) => rel === d || rel.startsWith(`${d}/`))) {
      manifest.dropped.push(rel);
      fs.rmSync(abs);
    } else if (!isText(buf)) {
      if (buf.toString('latin1').match(forbid)) manifest.binaryHits.push(rel);
    } else {
      const text = buf.toString('utf8');
      const n = text.match(forbid)?.length ?? 0;
      if (n) {
        manifest.scrubbed[rel] = n;
        fs.writeFileSync(abs, text.replace(forbid, SCRUB_WORD));
      }
    }
  }
  if (rulesOut) manifest.history = writeHistory(source, full, manifest.ruleFiles.filter((rel) => fs.existsSync(path.join(rulesOut, rel))), rulesOut, forbid);
  git(['-C', out, 'init', '-q', '-b', 'main']);
  // Windows antivirus can hold a fresh loose object for a moment (Permission denied); add is idempotent, so it gets three tries.
  for (let attempt = 1; ; attempt++) {
    try {
      git(['-C', out, 'add', '-A']);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
  git(['-C', out, 'commit', '-q', '--no-gpg-sign', '-m', 'snapshot'], { env: { ...process.env, ...IDENTITY } });
  return { ...manifest, snapshotCommit: git(['-C', out, 'rev-parse', 'HEAD']) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const drop = argv.flatMap((a, i) => (a === '--drop' ? [argv[i + 1]] : []));
  try {
    const [source, commit, out, manifestPath] = ['--source', '--commit', '--out', '--manifest'].map(flag);
    if (!source || !commit || !out || !manifestPath) throw new Error('usage: node scripts/token-eval/eval-snapshot.mjs --source DIR --commit REF --out DIR --manifest FILE [--rules-out DIR] [--forbid-set default|hippo-repo] [--drop PATH ...]');
    const manifest = buildSnapshot({ source, commit, out, forbidSet: flag('--forbid-set') ?? 'default', drop, rulesOut: flag('--rules-out') });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ snapshotCommit: manifest.snapshotCommit, ruleFiles: manifest.ruleFiles.length, dropped: manifest.dropped.length, scrubbed: Object.keys(manifest.scrubbed).length, binaryHits: manifest.binaryHits.length }));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
