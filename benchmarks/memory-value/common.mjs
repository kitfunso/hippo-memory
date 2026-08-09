/**
 * LC2-E1 memory-value eval — shared utilities.
 *
 * Not one of the plan's named deliverable files, but everything here is
 * shared by 3+ of them (split/ingest/simulate/extract/run); factoring it out
 * once avoids five copies of the same PRNG/date-parse/env-cache bugs.
 *
 * Determinism contract (mirrors scripts/e1-lifecycle/generate.mjs): every
 * random choice in this harness goes through `mulberry32` seeded via
 * `seedFromString`. No Math.random() anywhere in benchmarks/memory-value/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the repo's existing seeded PRNG rather than hand-rolling a second
// copy (coding-standards: prefer established code over a fresh
// implementation when one already exists in-repo).
export { mulberry32 } from '../../scripts/lifecycle-stress/inject.mjs';
import { mulberry32 } from '../../scripts/lifecycle-stress/inject.mjs';
import { _resetAblationCacheForTests } from '../../dist/ablation.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const RESULTS_DIR = path.join(HERE, 'results');

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Deterministic 32-bit FNV-1a hash of a string, for seeding mulberry32 from
 *  arbitrary strings (question ids, question types, stage names). */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded PRNG namespaced by stage + parts, e.g. rngFor('simulate', qid). */
export function rngFor(...parts) {
  return mulberry32(seedFromString(parts.join('|')));
}

/** Pick a uniformly random element via a seeded rand() in [0,1). */
export function pickUniform(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/** Fisher-Yates shuffle with a seeded PRNG (does not mutate input). */
export function seededShuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// LongMemEval date parsing: "YYYY/MM/DD (Day) HH:mm" -> canonical ISO
// ---------------------------------------------------------------------------

const LME_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2}) \((\w{3})\) (\d{2}):(\d{2})$/;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Parse a LongMemEval date string ("2023/05/30 (Tue) 23:40") into a
 * canonical Date.toISOString() string (UTC, seconds/ms zeroed), suitable for
 * HIPPO_FAKE_NOW (which requires exact round-trip ISO — see ablation.ts).
 * Throws on malformed input or a weekday that doesn't match the parsed date
 * (defends against a silently-corrupted dataset row).
 */
export function parseLmeDate(s) {
  const m = LME_DATE_RE.exec(s);
  if (!m) throw new Error(`parseLmeDate: unrecognized format: ${JSON.stringify(s)}`);
  const [, y, mo, d, dow, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
  const dt = new Date(iso);
  if (dt.toISOString() !== iso) {
    throw new Error(`parseLmeDate: does not round-trip (rolled-over date?): ${JSON.stringify(s)} -> ${iso}`);
  }
  const expectedDow = DOW[dt.getUTCDay()];
  if (expectedDow !== dow) {
    throw new Error(
      `parseLmeDate: weekday mismatch for ${JSON.stringify(s)}: computed ${expectedDow}, dataset says ${dow}`,
    );
  }
  return iso;
}

/**
 * Inverse of parseLmeDate: format a UTC Date as "YYYY/MM/DD (Day) HH:mm".
 * Used only by the smoke fixture generator (and tests) — real dataset dates
 * always come from the file, never from this function.
 */
export function formatLmeDate(date) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const dow = DOW[date.getUTCDay()];
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  return `${y}/${mo}/${d} (${dow}) ${h}:${mi}`;
}

// ---------------------------------------------------------------------------
// HIPPO_FAKE_NOW — the one place that sets it, so the ablation-cache-reset
// contract can never be forgotten at a call site. ablation.ts's readFlags()
// caches on FIRST read (see src/ablation.ts JSDoc); every write here MUST be
// paired with _resetAblationCacheForTests() or a stale cached value leaks
// into every subsequent evalNow() call in this process.
// ---------------------------------------------------------------------------

/** Set the simulated clock. `iso` must be a canonical Date.toISOString() string. */
export function setFakeNow(iso) {
  process.env.HIPPO_FAKE_NOW = iso;
  _resetAblationCacheForTests();
}

/** Clear the simulated clock (real wall-clock resumes). */
export function clearFakeNow() {
  delete process.env.HIPPO_FAKE_NOW;
  _resetAblationCacheForTests();
}

// ---------------------------------------------------------------------------
// Scratch-store paths. NEVER under the repo, NEVER touching ~/.hippo or any
// .hippo ancestor (probation memory: feedback_hippo_probe_scratch_stores).
// Built with path.join throughout so Windows/Git-Bash paths stay correct.
// ---------------------------------------------------------------------------

export function scratchRootDir() {
  return path.join(os.tmpdir(), 'hippo-mv-stores');
}

export function questionDir(questionId) {
  return path.join(scratchRootDir(), questionId);
}

/** The hippoRoot passed to store.ts/memory.ts/search.ts functions directly
 *  (a bare directory — NOT a `.hippo`-named subfolder; matches the
 *  scripts/e1-lifecycle/run.mjs precedent of calling initStore() on a plain
 *  mkdtemp dir). Nested one level under questionDir so the sidecar JSON
 *  files (gold.json, meta.json) don't sit inside hippo's own directory. */
export function hippoRootFor(questionId) {
  return path.join(questionDir(questionId), 'store');
}

export function goldPathFor(questionId) {
  return path.join(questionDir(questionId), 'gold.json');
}

export function metaPathFor(questionId) {
  return path.join(questionDir(questionId), 'meta.json');
}

export function featuresPathFor(questionId) {
  return path.join(questionDir(questionId), 'features.jsonl');
}

// ---------------------------------------------------------------------------
// JSON / JSONL IO
// ---------------------------------------------------------------------------

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

export function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export function readJsonl(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Dataset loading (real file OR a caller-supplied array, e.g. the smoke fixture)
// ---------------------------------------------------------------------------

export function loadDataset(dataPath) {
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const data = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);
  if (!Array.isArray(data)) throw new Error(`loadDataset: expected an array at ${dataPath}`);
  return data;
}

// ---------------------------------------------------------------------------
// Gold detection (plan: "Gold = evidence-TURN-level ... IF the cleaned
// dataset retains those flags ... fallback = all turns of answer sessions").
// Auto-detected PER QUESTION: if any turn in any answer session carries the
// `has_answer` key, mode = 'evidence-turn' and gold = has_answer===true
// turns; otherwise mode = 'answer-session-all' and gold = every turn of
// every answer session.
// ---------------------------------------------------------------------------

/**
 * @returns {{ mode: 'evidence-turn'|'answer-session-all',
 *             turns: Array<{sessionId, sessionIndex, turnIdx, isAnswerSession, isGold}> }}
 *   `turns` covers EVERY turn in EVERY haystack session (not just gold ones)
 *   — ingest.mjs needs the full list to build its memory-id <-> turn map.
 */
export function computeGold(question) {
  const answerSessionSet = new Set(question.answer_session_ids ?? []);
  let anyHasAnswerKey = false;
  const turns = [];
  for (let si = 0; si < question.haystack_sessions.length; si++) {
    const sessionId = question.haystack_session_ids[si];
    const isAnswerSession = answerSessionSet.has(sessionId);
    const sessionTurns = question.haystack_sessions[si];
    for (let ti = 0; ti < sessionTurns.length; ti++) {
      const t = sessionTurns[ti];
      if (isAnswerSession && Object.prototype.hasOwnProperty.call(t, 'has_answer')) {
        anyHasAnswerKey = true;
      }
      turns.push({
        sessionId,
        sessionIndex: si,
        turnIdx: ti,
        isAnswerSession,
        hasAnswerFlag: isAnswerSession ? t.has_answer === true : false,
        role: t.role,
        content: t.content,
      });
    }
  }
  const mode = anyHasAnswerKey ? 'evidence-turn' : 'answer-session-all';
  for (const t of turns) {
    t.isGold = mode === 'evidence-turn' ? t.hasAnswerFlag : t.isAnswerSession;
    delete t.hasAnswerFlag;
  }
  return { mode, turns };
}

// ---------------------------------------------------------------------------
// Smoke fixture — a tiny, fully-synthetic dataset in the exact LongMemEval
// shape, so `run.mjs --smoke` can exercise split -> ingest -> simulate ->
// extract -> evaluate end to end with no dependency on the real (277MB,
// main-checkout-only) dataset file. Deterministic (seeded), never touches
// Math.random or the real clock.
//
// Exercises BOTH gold-detection modes on purpose: even-indexed questions
// carry a `has_answer` flag on their answer session (evidence-turn mode),
// odd-indexed questions omit the key entirely (answer-session-all fallback).
// ---------------------------------------------------------------------------

const SMOKE_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
];

const SMOKE_TOPICS = ['pipeline', 'gateway', 'archive', 'console', 'scheduler', 'registry'];
const SMOKE_ATTRS = ['deadline', 'owner', 'budget', 'status', 'location', 'priority'];

/** @param {{questionsPerType?: number, sessionsPerQuestion?: number, turnsPerSession?: number}} [opts] */
export function generateSmokeFixture(opts = {}) {
  const questionsPerType = opts.questionsPerType ?? 2;
  const sessionsPerQuestion = opts.sessionsPerQuestion ?? 3;
  const turnsPerSession = opts.turnsPerSession ?? 3;
  const rand = rngFor('smoke-fixture');

  const baseDate = Date.UTC(2024, 0, 1, 9, 0, 0); // 2024-01-01T09:00:00Z (a Monday)
  const questions = [];
  let qIdx = 0;
  for (const type of SMOKE_TYPES) {
    for (let qi = 0; qi < questionsPerType; qi++) {
      const questionId = `smoke_${type}_${qi}`;
      const evidenceMode = qIdx % 2 === 0;
      const haystack_session_ids = [];
      const haystack_dates = [];
      const haystack_sessions = [];
      const answerSessionIdx = sessionsPerQuestion - 1; // last session is always the answer session

      for (let si = 0; si < sessionsPerQuestion; si++) {
        const sessionDate = new Date(baseDate + (qIdx * 10 + si) * 86400000 + Math.floor(rand() * 3600000));
        haystack_session_ids.push(`${questionId}_sess${si}`);
        haystack_dates.push(formatLmeDate(sessionDate));
        const turns = [];
        const isAnswerSession = si === answerSessionIdx;
        const answerTurnIdx = isAnswerSession ? turnsPerSession - 1 : -1;
        for (let ti = 0; ti < turnsPerSession; ti++) {
          const topic = pickUniform(rand, SMOKE_TOPICS);
          const attr = pickUniform(rand, SMOKE_ATTRS);
          const role = ti % 2 === 0 ? 'user' : 'assistant';
          const turn = {
            role,
            content: `[${questionId}/s${si}/t${ti}] the ${topic} ${attr} note number ${Math.floor(rand() * 1000)}`,
          };
          if (isAnswerSession && evidenceMode) {
            turn.has_answer = ti === answerTurnIdx;
          }
          turns.push(turn);
        }
        haystack_sessions.push(turns);
      }

      const questionDate = new Date(baseDate + (qIdx * 10 + sessionsPerQuestion) * 86400000 + 3600000);
      questions.push({
        question_id: questionId,
        question_type: type,
        question: `smoke question for ${questionId} (never read by simulate/extract)`,
        question_date: formatLmeDate(questionDate),
        answer: `smoke answer for ${questionId} (never read by simulate/extract)`,
        answer_session_ids: [haystack_session_ids[answerSessionIdx]],
        haystack_dates,
        haystack_session_ids,
        haystack_sessions,
      });
      qIdx++;
    }
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Stratified largest-remainder apportionment (used by split.mjs for the
// exact 300/train-200/heldout target, and by run.mjs for --questions N).
// Deterministic tie-break: fractional part descending, then bucket key
// ascending (alphabetical) — no RNG involved, apportionment is arithmetic.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, number>} counts  bucket key -> total items
 * @param {number} totalTarget  desired sum of returned per-bucket counts
 * @returns {Record<string, number>} bucket key -> allocated count, summing to totalTarget
 */
export function apportionLargestRemainder(counts, totalTarget) {
  const keys = Object.keys(counts).sort();
  const total = keys.reduce((a, k) => a + counts[k], 0);
  const exact = {};
  const base = {};
  let baseSum = 0;
  for (const k of keys) {
    exact[k] = total > 0 ? (counts[k] * totalTarget) / total : 0;
    base[k] = Math.floor(exact[k]);
    baseSum += base[k];
  }
  let remainder = totalTarget - baseSum;
  const byFracDesc = keys.slice().sort((a, b) => {
    const fa = exact[a] - base[a];
    const fb = exact[b] - base[b];
    if (fb !== fa) return fb - fa;
    return a.localeCompare(b);
  });
  const out = { ...base };
  for (let i = 0; i < remainder; i++) {
    out[byFracDesc[i % byFracDesc.length]] += 1;
  }
  return out;
}
