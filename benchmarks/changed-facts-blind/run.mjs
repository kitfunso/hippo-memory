#!/usr/bin/env node
// G2b of docs/evals/2026-11-16-changed-facts-prereg.md: each blind pair in a fresh store through the real CLI,
// old note at day 0, new note at gapDays, one sleep a day later; reads what sleep did to the old row.
// Usage: node run.mjs --bin <worktree>/bin/hippo.js --root-base <dir inside the temp dir> --out <file.json> [--workers 4]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EPOCH_MS = Date.UTC(2026, 8, 1, 9);
const day = (n) => new Date(EPOCH_MS + n * 86400000).toISOString();

function args(argv) {
  const out = { workers: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bin') out.bin = path.resolve(argv[++i]);
    else if (argv[i] === '--root-base') out.rootBase = path.resolve(argv[++i]);
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--workers') out.workers = Number(argv[++i]);
  }
  if (!out.bin || !out.rootBase || !out.out) throw new Error('usage: --bin <hippo.js> --root-base <dir> --out <file>');
  const rel = path.relative(fs.realpathSync(os.tmpdir()), (fs.mkdirSync(out.rootBase, { recursive: true }), fs.realpathSync(out.rootBase)));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`--root-base must be inside ${os.tmpdir()}`);
  return out;
}

function envFor(root, fakeNow) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET/i.test(k) || k.startsWith('HIPPO_') || k.startsWith('CLAUDE') || k.startsWith('GIT_') || k === 'XDG_DATA_HOME') delete env[k];
  }
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), HIPPO_HOME: path.join(root, 'hh'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_FAKE_NOW: fakeNow });
  return env;
}

function hippo(bin, argv, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...argv], { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`hippo ${argv[0]} failed: ${(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

async function runPair(o, pair, group) {
  const root = path.join(o.rootBase, group, pair.id);
  fs.rmSync(root, { recursive: true, force: true });
  const proj = path.join(root, 'proj');
  for (const d of [proj, path.join(root, 'home'), path.join(root, 'hh')]) fs.mkdirSync(d, { recursive: true });
  await hippo(o.bin, ['init', '--no-hooks', '--no-schedule', '--no-learn'], proj, envFor(root, day(-1)));
  const idOf = (out) => /Remembered \[(\S+)\]/.exec(out)?.[1];
  const oldId = idOf(await hippo(o.bin, ['remember', pair.old], proj, envFor(root, day(0))));
  const newId = idOf(await hippo(o.bin, ['remember', pair.new], proj, envFor(root, day(pair.gapDays))));
  if (!oldId || !newId) throw new Error(`${pair.id}: remember printed no id`);
  const sleepOut = await hippo(o.bin, ['sleep', '--no-learn'], proj, envFor(root, day(pair.gapDays + 1)));
  const db = new DatabaseSync(path.join(proj, '.hippo', 'hippo.db'), { readOnly: true });
  const row = db.prepare('SELECT superseded_by, confidence, tags_json FROM memories WHERE id = ?').get(oldId);
  db.close();
  const tags = row ? JSON.parse(row.tags_json || '[]') : [];
  let action = 'none';
  if (!row) action = 'gone';
  else if (row.superseded_by === newId) action = 'hide';
  else if (row.confidence === 'stale' && tags.includes(`replaced-by:${newId}`)) action = 'soft';
  else if (row.superseded_by || row.confidence === 'stale') action = 'other';
  return { id: pair.id, group, kind: pair.kind, domain: pair.domain ?? null, action, oldId, newId, sleepTail: sleepOut.trim().split('\n').slice(-4) };
}

async function pool(items, n, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function wilson(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d].map((x) => Math.round(x * 1000) / 1000);
}

const o = args(process.argv.slice(2));
const load = (f) => { const b = fs.readFileSync(path.join(HERE, f)); return { pairs: JSON.parse(b), sha256: createHash('sha256').update(b).digest('hex') }; };
const changes = load('changes.json'), looks = load('lookalikes.json');
const jobs = [...changes.pairs.map((p) => [p, 'change']), ...looks.pairs.map((p) => [p, 'lookalike'])];
const results = await pool(jobs, o.workers, ([p, g]) => runPair(o, p, g).catch((e) => ({ id: p.id, group: g, kind: p.kind, error: e.message })));
const errors = results.filter((r) => r.error);
const count = (g, acts) => results.filter((r) => r.group === g && acts.includes(r.action)).length;
const nC = changes.pairs.length;
const summary = {
  lookalikeHidden: count('lookalike', ['hide']),
  lookalikeActed: count('lookalike', ['hide', 'soft', 'other']),
  changeActed: count('change', ['hide', 'soft']),
  changeHidden: count('change', ['hide']),
  changeSoft: count('change', ['soft']),
  changeOther: count('change', ['other', 'gone']),
  errors: errors.length,
};
summary.changeActedWilson = wilson(summary.changeActed, nC);
summary.gate = {
  lookalikeHiddenAtMost3: summary.lookalikeHidden <= 3,
  lookalikeActedAtMost9: summary.lookalikeActed <= 9,
  changeActedAtLeast12: summary.changeActed >= 12,
  noErrors: errors.length === 0,
};
summary.pass = Object.values(summary.gate).every(Boolean);
const binSha = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(o.bin), '..', 'dist', 'cli.js'))).digest('hex');
fs.writeFileSync(o.out, JSON.stringify({ bin: o.bin, distCliSha256: binSha, fixtures: { changes: changes.sha256, lookalikes: looks.sha256 }, summary, results }, null, 1));
console.log(JSON.stringify({ out: o.out, ...summary }));
