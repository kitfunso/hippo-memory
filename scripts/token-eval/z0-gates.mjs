/** Z0 analyzer, part 4 of 6: validity gates G1-G5 (prereg 154-166). Each returns `pass` plus the numbers it read.
 * A failed gate makes the run invalid; a half or gate whose arms were not planned is "not run" (reading 11). */

import { DESIGNS, allowlistOf, envAllowSet, isRound4Design } from './arms.mjs';
import { CODINGS, NOT_RUN, bothCodings, codexApply, firstApplyR } from './z0-hypotheses.mjs';

export const OPERATOR_CANARY = 'operator-canary';
const EPS = 1e-9;

/** G1 (reading 3): an operator canary, an `envKeys` name outside the design's env allowlist, or ANTHROPIC_API_KEY invalidates the run; other voids drop sessions, with per-arm shares printed.
 * With `offPinVoided` (the off-pin bar, item 6) the positions off-pin voids reach, tails included, must also be at most 5% of those planned.
 * @param {any[]} records @param {Record<string, any>} counts @param {{design?: any, offPinVoided?: {positions: number, share: number}}} [options]
 * @returns {{pass: boolean, operatorCanaries: number, envKeysOutside: Record<string, number>, anthropicApiKeyRecords: number, perArm: Record<string, {voids: number, share: number}>, offPinVoided?: {positions: number, share: number}, offPinPass?: boolean}} */
export function g1(records, counts, { design, offPinVoided } = {}) {
  // Prereg 161: a canary anywhere fails the run, so one an apply's resume saw counts though it never sets that cell's void.
  const seen = (r) => r.void === OPERATOR_CANARY || (r.resumeVoidHits ?? []).some((h) => h.reason === OPERATOR_CANARY);
  const canaries = records.filter(seen).length;
  const allowed = envAllowSet(allowlistOf(design ?? DESIGNS.r3));
  const outside = new Map();
  let anthropicApiKeyRecords = 0;
  for (const r of records) {
    const names = new Set((Array.isArray(r.envKeys) ? r.envKeys : []).map((k) => k.toUpperCase()));
    for (const name of names) if (!allowed.has(name)) outside.set(name, (outside.get(name) ?? 0) + 1);
    if (names.has('ANTHROPIC_API_KEY')) anthropicApiKeyRecords += 1;
  }
  const envKeysOutside = Object.fromEntries([...outside].sort(([a], [b]) => (a < b ? -1 : 1)));
  const perArm = Object.fromEntries(Object.entries(counts).map(([arm, c]) => [arm, { voids: c.voids, share: c.planned === 0 ? 0 : c.voids / c.planned }]));
  const gate = { pass: canaries === 0 && outside.size === 0 && anthropicApiKeyRecords === 0, operatorCanaries: canaries, envKeysOutside, anthropicApiKeyRecords, perArm };
  if (offPinVoided === undefined) return gate;
  const offPinPass = offPinVoided.share <= 0.05 + EPS;
  return { ...gate, pass: gate.pass && offPinPass, offPinVoided, offPinPass };
}

/** One G2 half: under both codings, estimate at most -0.30 and the CI's high below zero (reading 5).
 * @returns {{status: string, required: boolean, pass: boolean} & Partial<ReturnType<typeof bothCodings>>} the per-coding estimates only when the half ran */
function g2Half(filtered, armT, armC, keep, required, opts) {
  const planned = new Set(filtered.arms);
  if (!planned.has(armT) || !planned.has(armC)) return { status: NOT_RUN, required, pass: !required };
  const est = bothCodings(filtered.scored, armT, armC, opts, keep);
  const ok = CODINGS.every((c) => est[c].estimate <= -0.3 + EPS && est[c].high < 0);
  return { status: ok ? 'pass' : 'fail', required, pass: ok, ...est };
}

const G2_KEEP = { claudeCode: firstApplyR, codex: codexApply };

/** G2 from the design's halves: a half runs when its taught and control arms are planned, and is required when every arm its tests need is planned; a null half is not run and not required. */
export function g2(filtered, opts) {
  const planned = new Set(filtered.arms);
  const halves = (opts.design ?? DESIGNS.r3).g2;
  /** @param {'claudeCode' | 'codex'} name @returns {ReturnType<typeof g2Half>} */
  const half = (name) => {
    const h = halves[name];
    return h === null ? { status: NOT_RUN, required: false, pass: true } : g2Half(filtered, h.taught, h.control, G2_KEEP[name], h.needs.every((a) => planned.has(a)), opts);
  };
  const [claudeCode, codex] = [half('claudeCode'), half('codex')];
  return { pass: claudeCode.pass && codex.pass, claudeCode, codex };
}

/** G3: leaked (sequence, seed)s at most 5% of those planned. A `firstRun` count is printed beside it and does not move `pass`.
 * @param {number} leaked @param {number} plannedRuns @param {{leakedSequenceSeeds: number, plannedRuns: number} | null} [firstRun]
 * @returns {{pass: boolean, leaked: number, plannedRuns: number, share: number, firstRun?: {leakedSequenceSeeds: number, plannedRuns: number}}} */
export function g3(leaked, plannedRuns, firstRun = null) {
  const gate = { pass: leaked * 20 <= plannedRuns, leaked, plannedRuns, share: plannedRuns === 0 ? 0 : leaked / plannedRuns };
  return firstRun === null ? gate : { ...gate, firstRun };
}

/** G4 from the step-0 counts: (invalid + missing) at most 5% per arm, at most 3 points between arms, and hook-voided positions at most 5%. */
export function g4(counts, hookVoided = { positions: 0, share: 0 }) {
  const perArm = Object.fromEntries(Object.entries(counts).map(([arm, c]) => {
    const bad = c.invalid + c.missing;
    return [arm, { invalid: c.invalid, missing: c.missing, planned: c.planned, share: c.planned === 0 ? 0 : bad / c.planned, pass: bad * 20 <= c.planned }];
  }));
  const shares = Object.values(perArm).map((a) => a.share);
  const gap = shares.length === 0 ? 0 : Math.max(...shares) - Math.min(...shares);
  const armsPass = Object.values(perArm).every((a) => a.pass);
  const hookPass = hookVoided.share <= 0.05 + EPS;
  return { pass: armsPass && gap <= 0.03 + EPS && hookPass, gap, armsPass, gapPass: gap <= 0.03 + EPS, hookVoided, hookPass, perArm };
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

/** Every gate, then `failed`, the names a report prints as "invalid: G<n>". The off-pin bar and the first-run count are on under a round 4 design,
 * with `opts.offPinGiven`, or with `opts.mergeManifests` (readMergeManifest results, whose leaked sequence-seed counts are summed); off, every gate keeps its round 3 keys. */
export function computeGates(records, filtered, grading, opts) {
  const design = opts.design ?? DESIGNS.r3;
  const manifests = opts.mergeManifests ?? [];
  const bar = isRound4Design(design) || opts.offPinGiven === true || manifests.length > 0;
  const firstLeaked = manifests.reduce((n, m) => n + m.firstRun.leakedSequenceSeeds, 0);
  const gates = {
    G1: g1(records, filtered.counts, bar ? { design, offPinVoided: filtered.offPinVoided } : { design }),
    G2: g2(filtered, opts),
    G3: g3(filtered.leaked.length, filtered.plannedRuns, bar ? { leakedSequenceSeeds: firstLeaked, plannedRuns: filtered.plannedRuns } : null),
    G4: g4(filtered.counts, filtered.hookVoided),
    G5: g5(grading),
  };
  const failed = Object.keys(gates).filter((g) => !gates[g].pass);
  return { ...gates, failed, pass: failed.length === 0 };
}
