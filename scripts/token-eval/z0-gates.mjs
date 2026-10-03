/** Z0 analyzer, part 4 of 6: validity gates G1-G5 (prereg 154-166). Each returns `pass` plus the numbers it read.
 * A failed gate makes the run invalid; a half or gate whose arms were not planned is "not run" (reading 11). */

import { CODINGS, NOT_RUN, bothCodings, codexApply, inSets } from './z0-hypotheses.mjs';

export const OPERATOR_CANARY = 'operator-canary';
const EPS = 1e-9;

/** G1 (reading 3): an operator canary invalidates the run; other voids drop sessions, with per-arm shares printed. */
export function g1(records, counts) {
  const canaries = records.filter((r) => r.void === OPERATOR_CANARY).length;
  const perArm = Object.fromEntries(Object.entries(counts).map(([arm, c]) => [arm, { voids: c.voids, share: c.planned === 0 ? 0 : c.voids / c.planned }]));
  return { pass: canaries === 0, operatorCanaries: canaries, perArm };
}

/** One G2 half: under both codings, estimate at most -0.30 and the CI's high below zero (reading 5). */
function g2Half(filtered, armT, armC, keep, required, opts) {
  const planned = new Set(filtered.arms);
  if (!planned.has(armT) || !planned.has(armC)) return { status: NOT_RUN, required, pass: !required };
  const est = bothCodings(filtered.scored, armT, armC, opts, keep);
  const ok = CODINGS.every((c) => est[c].estimate <= -0.3 + EPS && est[c].high < 0);
  return { status: ok ? 'pass' : 'fail', required, pass: ok, ...est };
}

/** G2: the Claude Code half is required whenever H1 or H3 runs, the Codex half whenever H2 runs. */
export function g2(filtered, opts) {
  const planned = new Set(filtered.arms);
  const ccNeeded = planned.has('A1') && planned.has('A2');
  const codexNeeded = planned.has('X2') && planned.has('X3');
  const claudeCode = g2Half(filtered, 'A4', 'A0', inSets('R'), ccNeeded, opts);
  const codex = g2Half(filtered, 'X4', 'X1', codexApply, codexNeeded, opts);
  return { pass: claudeCode.pass && codex.pass, claudeCode, codex };
}

/** G3: leaked (sequence, seed)s, counted before abandonment removal, at most 5% of those planned. */
export function g3(leaked, plannedRuns) {
  return { pass: leaked * 20 <= plannedRuns, leaked, plannedRuns, share: plannedRuns === 0 ? 0 : leaked / plannedRuns };
}

/** G4 from the step-0 counts: (invalid + missing) at most 5% per arm, and at most 3 points between arms. */
export function g4(counts) {
  const perArm = Object.fromEntries(Object.entries(counts).map(([arm, c]) => {
    const bad = c.invalid + c.missing;
    return [arm, { invalid: c.invalid, missing: c.missing, planned: c.planned, share: c.planned === 0 ? 0 : bad / c.planned, pass: bad * 20 <= c.planned }];
  }));
  const shares = Object.values(perArm).map((a) => a.share);
  const gap = shares.length === 0 ? 0 : Math.max(...shares) - Math.min(...shares);
  const armsPass = Object.values(perArm).every((a) => a.pass);
  return { pass: armsPass && gap <= 0.03 + EPS, gap, armsPass, gapPass: gap <= 0.03 + EPS, perArm };
}

/** G5 (166): a missing grading file fails; under 30 sampled pairs is short; more than 10% disagreeing needs a re-grade. */
export function g5(grading) {
  if (grading === null || grading === undefined) return { pass: false, status: 'grading file missing' };
  const { n, disagreements } = grading.readerSample;
  const base = { n, disagreements, flippedLessons: grading.flippedLessons.length, acceptanceFlips: grading.acceptanceFlips };
  if (n < 30) return { pass: false, status: 'reader sample short', ...base };
  if (disagreements * 10 > n) return { pass: false, status: 're-grade required', ...base };
  return { pass: true, status: 'pass', ...base };
}

/** Every gate, then `failed`, the names a report prints as "invalid: G<n>". */
export function computeGates(records, filtered, grading, opts) {
  const gates = {
    G1: g1(records, filtered.counts),
    G2: g2(filtered, opts),
    G3: g3(filtered.leaked.length, filtered.plannedRuns),
    G4: g4(filtered.counts),
    G5: g5(grading),
  };
  const failed = Object.keys(gates).filter((g) => !gates[g].pass);
  return { ...gates, failed, pass: failed.length === 0 };
}
