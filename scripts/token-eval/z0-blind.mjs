/** Z0 analyzer, part 5 of 6: blind codes, the key file, the blind report, unblind checks and input hashes (prereg 168, 240).
 * The key is plaintext beside the records, so blindness is procedural: it stops a reader, not a determined operator. */

import { createHash, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ARMS } from './z0-records.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const MODULES = ['records', 'filters', 'hypotheses', 'gates', 'blind', 'analyze'].map((m) => `scripts/token-eval/z0-${m}.mjs`)
  .concat(['src/eval-stats.ts', 'dist/eval-stats.js']);
export const SEALED = 'hypotheses sealed until unblinded';
const ARM_WORD = new RegExp(`\\b(${ALL_ARMS.join('|')})\\b`, 'g');

/** Codes K1..Kn in a `crypto.randomInt` order; a second run reuses the key and refuses one for another arm set. */
export function loadOrCreateKey(keyPath, arms) {
  if (fs.existsSync(keyPath)) {
    const codes = JSON.parse(fs.readFileSync(keyPath, 'utf8')).codes ?? {};
    const keyed = Object.keys(codes).sort();
    if (keyed.join(',') !== [...arms].sort().join(',')) {
      throw new Error(`key ${keyPath} was made for another arm set; move it aside or pass --key`);
    }
    return codes;
  }
  const pool = arms.map((_, i) => `K${i + 1}`);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const codes = Object.fromEntries(arms.map((a, i) => [a, pool[i]]));
  fs.writeFileSync(keyPath, `${JSON.stringify({ codes }, null, 2)}\n`);
  return codes;
}

const byCode = (perArm, codes) => Object.fromEntries(Object.entries(perArm).map(([arm, v]) => [codes[arm], v]).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));

/** Void reasons summed over codes; a reason could point at an arm, so with fewer than two codes voided only the total shows. */
export function pooledVoids(counts) {
  const reasons = new Map();
  let total = 0;
  for (const c of Object.values(counts)) {
    for (const [reason, n] of Object.entries(c.voidReasons)) {
      const safe = reason.replace(ARM_WORD, '*');
      reasons.set(safe, (reasons.get(safe) ?? 0) + n);
      total += n;
    }
  }
  const voidedCodes = Object.values(counts).filter((c) => c.voids > 0).length;
  return voidedCodes < 2 ? { total } : { total, reasons: Object.fromEntries([...reasons].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Only what the gates need: per-code counts and shares, pooled void reasons, G1-G5 with codes for arms (null when abandoned). */
export function blindView(analysis, codes) {
  const perCode = byCode(Object.fromEntries(Object.entries(analysis.filtered.counts).map(([arm, c]) => {
    const share = (n) => (c.planned === 0 ? 0 : n / c.planned);
    return [arm, { planned: c.planned, records: c.records, voids: c.voids, invalid: c.invalid, missing: c.missing, abandoned: c.abandoned,
      voidShare: share(c.voids), invalidShare: share(c.invalid), missingShare: share(c.missing) }];
  })), codes);
  const g = analysis.gates;
  const gates = g === null ? null : { ...g, G1: { ...g.G1, perArm: byCode(g.G1.perArm, codes) }, G4: { ...g.G4, perArm: byCode(g.G4.perArm, codes) } };
  return { perCode, voids: pooledVoids(analysis.filtered.counts), gates };
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** Why a file cannot back an unblind: untracked, or changed since its commit; null when it is committed and clean. */
export function uncommitted(file, cwd) {
  const abs = path.resolve(cwd, file);
  const [dir, base] = [path.dirname(abs), path.basename(abs)];
  if (!fs.existsSync(abs)) return `${file} does not exist`;
  if (git(['ls-files', '--error-unmatch', '--', base], dir).status !== 0) return `${file} is not tracked by git`;
  const status = git(['status', '--porcelain', '--', base], dir);
  if (status.status !== 0 || status.stdout.trim() !== '') return `${file} has uncommitted changes`;
  return null;
}

/** Prereg 166 and 168: the drop list and grading file committed, and G5 passing, before any code opens. */
export function unblindRefusal(args, gates, cwd) {
  if (args.iterations !== null || args.seed !== null) return '--iterations and --seed are blind-only; an unblinded run uses 10,000 resamples and seed 1';
  if (!gates.G5.pass) return `G5: ${gates.G5.status}`;
  if (args.dropList === null) return '--drop-list FILE is required to unblind';
  for (const file of [args.dropList, args.grading]) {
    const why = uncommitted(file, cwd);
    if (why !== null) return why;
  }
  return null;
}

export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** sha256 of every input, labelled as given on argv, and of the analyzer and eval-stats sources, labelled repo-relative. */
export function inputHashes(args, cwd) {
  const inputs = [
    ...args.runs.map((f) => ['runs', f]), ...args.plan.map((f) => ['plan', f]), ['prices', args.prices],
    ['grading', args.grading], ['drop-list', args.dropList],
  ].filter(([, f]) => f !== null);
  return [
    ...inputs.map(([role, f]) => ({ role, file: f, sha256: sha256(path.resolve(cwd, f)) })),
    ...MODULES.map((m) => ({ role: 'source', file: m, sha256: sha256(path.join(REPO, m)) })),
  ];
}
