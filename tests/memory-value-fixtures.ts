/**
 * Shared fixtures for the LC2-E1 memory-value harness test suite
 * (memory-value-harness.test.ts + memory-value-determinism.test.ts).
 *
 * Split out (codex confirmation-pass P1-B fix, 2026-08-09) so both test
 * files share one fixture definition instead of drifting copies — the
 * split itself exists so neither Vitest worker's per-file wallclock
 * crosses the ~60s Windows worker-RPC "onTaskUpdate" timeout.
 *
 * NOT matched by vitest.config.ts's test include glob
 * (`tests/**\/*.test.ts`), so this file is never itself run as a suite —
 * it is purely an import target.
 *
 * See memory-value-harness.test.ts's header for the hand-computable
 * retention design note (why Q_A/Q_B are shaped the way they are).
 */
import * as fs from 'node:fs';

// @ts-expect-error - .mjs harness modules have no type declarations
import { formatLmeDate, questionDir } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { ingestQuestion } from '../benchmarks/memory-value/ingest.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { simulateQuestion } from '../benchmarks/memory-value/simulate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { extractQuestion } from '../benchmarks/memory-value/extract.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { metaPathFor } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { readJson } from '../benchmarks/memory-value/common.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { _resetAblationCacheForTests } from '../dist/ablation.js';

// HIPPO_MV_SCRATCH_ROOT is included here (not just the ablation vars) so the
// cross-ingest determinism test can never leak its scratch-root override
// into another test if it throws before its own finally runs.
export const RESET_ENV_VARS = ['HIPPO_FAKE_NOW', 'HIPPO_MV_SCRATCH_ROOT'] as const;
export function clearAblationEnv(): void {
  for (const v of RESET_ENV_VARS) delete process.env[v];
  _resetAblationCacheForTests();
}

// ---------------------------------------------------------------------------
// Fixture: 2 questions, 3 sessions each, ~10 turns each, known gold flags.
// ---------------------------------------------------------------------------

export const BASE = Date.UTC(2024, 0, 1, 9, 0, 0); // 2024-01-01T09:00:00Z, a Monday
export const day = (n: number) => new Date(BASE + n * 86_400_000);

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

export function turn(role: 'user' | 'assistant', text: string, hasAnswer?: boolean): Turn {
  const t: Turn = { role, content: text };
  if (hasAnswer !== undefined) t.has_answer = hasAnswer;
  return t;
}

/** Q_A: evidence-turn mode. Sessions at day 0, 3, 6 (day 6 = newest = answer
 *  session). 4+3+3 = 10 turns. Exactly 1 gold turn (the last turn of the
 *  answer session). question_date = day 7 (one day after the newest session). */
export function buildQuestionA() {
  const s0 = [turn('user', 'A-s0-t0 alpha topic note'), turn('assistant', 'A-s0-t1 alpha topic reply'), turn('user', 'A-s0-t2 alpha topic follow-up'), turn('assistant', 'A-s0-t3 alpha topic wrap-up')];
  const s1 = [turn('user', 'A-s1-t0 beta topic note'), turn('assistant', 'A-s1-t1 beta topic reply'), turn('user', 'A-s1-t2 beta topic follow-up')];
  const s2 = [turn('user', 'A-s2-t0 gamma topic note', false), turn('assistant', 'A-s2-t1 gamma topic reply', false), turn('user', 'A-s2-t2 gamma topic answer', true)];
  return {
    question_id: 'fixture_q_a',
    question_type: 'single-session-user',
    question: 'What was the gamma topic answer? (never read by simulate/extract)',
    question_date: formatLmeDate(day(7)),
    answer: 'the gamma topic answer (never read by simulate/extract)',
    answer_session_ids: ['fixture_q_a_sess2'],
    haystack_dates: [formatLmeDate(day(0)), formatLmeDate(day(3)), formatLmeDate(day(6))],
    haystack_session_ids: ['fixture_q_a_sess0', 'fixture_q_a_sess1', 'fixture_q_a_sess2'],
    haystack_sessions: [s0, s1, s2],
  };
}

/** Q_B: answer-session-all fallback mode (no has_answer key anywhere).
 *  Sessions at day 0, 3, 6 (day 6 = newest = answer session, ALL 4 turns
 *  gold). 3+3+4 = 10 turns. question_date = day 7. */
export function buildQuestionB() {
  const s0 = [turn('user', 'B-s0-t0 delta topic note'), turn('assistant', 'B-s0-t1 delta topic reply'), turn('user', 'B-s0-t2 delta topic follow-up')];
  const s1 = [turn('user', 'B-s1-t0 epsilon topic note'), turn('assistant', 'B-s1-t1 epsilon topic reply'), turn('user', 'B-s1-t2 epsilon topic follow-up')];
  const s2 = [turn('user', 'B-s2-t0 zeta topic note'), turn('assistant', 'B-s2-t1 zeta topic reply'), turn('user', 'B-s2-t2 zeta topic follow-up'), turn('assistant', 'B-s2-t3 zeta topic answer')];
  return {
    question_id: 'fixture_q_b',
    question_type: 'multi-session',
    question: 'What was decided in the zeta topic thread? (never read by simulate/extract)',
    question_date: formatLmeDate(day(7)),
    answer: 'the zeta topic decision (never read by simulate/extract)',
    answer_session_ids: ['fixture_q_b_sess2'],
    haystack_dates: [formatLmeDate(day(0)), formatLmeDate(day(3)), formatLmeDate(day(6))],
    haystack_session_ids: ['fixture_q_b_sess0', 'fixture_q_b_sess1', 'fixture_q_b_sess2'],
    haystack_sessions: [s0, s1, s2],
  };
}

/** Q_C: causal clock clamp case. Sessions at day 0 and day 10 (day(10) is
 *  AFTER question_date = day 7 — mirrors the 76/500 real questions whose
 *  haystack postdates question_date). Answer session (day 10) has 1 gold
 *  turn. T_eval must clamp to day(10), not day(7), so every memory's
 *  age_days >= 0 (the day-10 session's own memories: age == 0 exactly). */
export function buildQuestionC() {
  const s0 = [turn('user', 'C-s0-t0 eta topic note'), turn('assistant', 'C-s0-t1 eta topic reply'), turn('user', 'C-s0-t2 eta topic follow-up')];
  const s1 = [turn('user', 'C-s1-t0 theta topic note', false), turn('assistant', 'C-s1-t1 theta topic reply', false), turn('user', 'C-s1-t2 theta topic answer', true)];
  return {
    question_id: 'fixture_q_c',
    question_type: 'temporal-reasoning',
    question: 'What was the theta topic answer? (never read by simulate/extract)',
    question_date: formatLmeDate(day(7)), // BEFORE session s1 (day 10) — the causal-clamp case
    answer: 'the theta topic answer (never read by simulate/extract)',
    answer_session_ids: ['fixture_q_c_sess1'],
    haystack_dates: [formatLmeDate(day(0)), formatLmeDate(day(10))],
    haystack_session_ids: ['fixture_q_c_sess0', 'fixture_q_c_sess1'],
    haystack_sessions: [s0, s1],
  };
}

export const QUESTIONS = [buildQuestionA(), buildQuestionB()];
export const QUESTION_C = buildQuestionC();

export function cleanupScratch(): void {
  for (const q of [...QUESTIONS, QUESTION_C]) {
    fs.rmSync(questionDir(q.question_id), { recursive: true, force: true });
  }
}

/**
 * Reduced simulation depth for the generic pipeline/mechanism tests (codex
 * confirmation-pass P1-B fix): CONFIG.SIM_ROUNDS (30) is the pinned
 * production protocol, but these tests only need ENOUGH usage variance to
 * exercise retrieval_count, outcome counters, half_life_days — 8 rounds over a
 * 10-turn fixture (SIM_TOP_K=5 -> 40 "slots") is still comfortably enough.
 * The ONE test that must run the full pinned protocol (cross-ingest
 * determinism, memory-value-determinism.test.ts) does NOT use this — it
 * omits `rounds` so simulateQuestion defaults to CONFIG.SIM_ROUNDS.
 */
export const TEST_SIM_ROUNDS = 8;

export async function runPipeline(q: ReturnType<typeof buildQuestionA>) {
  const ingestResult = ingestQuestion(q);
  // SAFETY: readJson is untyped (.mjs harness module); metaPathFor's file is
  // always written by ingestQuestion just above with a `tEval` field.
  const meta = readJson(metaPathFor(q.question_id)) as { tEval: string };
  await simulateQuestion(q.question_id, meta.tEval, { rounds: TEST_SIM_ROUNDS });
  const extractResult = extractQuestion(q.question_id, meta.tEval);
  return { ingestResult, extractResult, tEval: meta.tEval };
}
