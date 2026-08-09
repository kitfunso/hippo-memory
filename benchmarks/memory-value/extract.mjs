#!/usr/bin/env node
/**
 * LC2-E1 — blind per-memory feature extraction -> features.jsonl.
 *
 * Reads raw MemoryEntry fields straight from the store and DERIVES strength
 * via calculateStrength at extraction time (HIPPO_FAKE_NOW = question_date).
 * Binding constraint from the plan: stored `strength` writes are inert
 * (calculateStrength recomputes from last_retrieved/half_life_days/reward
 * and never reads the persisted `strength` column — src/memory.ts:309-385),
 * so this file never trusts entry.strength and always recomputes it here.
 *
 * Blind: nothing here reads query text, the eval answer, or gold labels
 * while computing a feature value. The `gold` column on each output row
 * comes from the gold.json sidecar (ingest.mjs), joined AFTER all 30
 * feature values are computed — gold never feeds a feature.
 *
 * Provenance (codex review fix round, 2026-08-09 P1 fix): every row also
 * carries `sessionIndex`/`turnIdx` (dataset-fixed, from gold.json's
 * memories list — which already carries the same {id, sessionIndex,
 * turnIdx} triples ingest.mjs writes to meta.json's `turns` for
 * simulate.mjs). `memory_id` is crypto-random per ingest and must never be
 * the ONLY join key between two runs of the same dataset; evaluate.mjs's
 * tie-break and any cross-ingest comparison join on this provenance key.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateStrength } from '../../dist/memory.js';
import { loadAllEntries } from '../../dist/store.js';
import { CONFIG } from './config.mjs';
import {
  setFakeNow,
  clearFakeNow,
  hippoRootFor,
  goldPathFor,
  metaPathFor,
  featuresPathFor,
  readJson,
  writeJsonl,
} from './common.mjs';

const VALENCE_LEVELS = ['neutral', 'positive', 'negative', 'critical'];
const LAYER_LEVELS = ['buffer', 'episodic', 'semantic', 'trace'];
const KIND_LEVELS = ['raw', 'distilled', 'superseded', 'archived'];
const CONFIDENCE_LEVELS = ['verified', 'observed', 'inferred', 'stale'];

function oneHot(prefix, levels, value) {
  const out = {};
  for (const level of levels) out[`${prefix}_${level}`] = value === level ? 1 : 0;
  return out;
}

/** Compute the blind v1 feature dict for one MemoryEntry. `now` = evalNow() snapshot. */
export function computeFeatures(entry, now) {
  const ageDays = (now.getTime() - Date.parse(entry.created)) / (1000 * 60 * 60 * 24);
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  const raw = {
    age_days: ageDays,
    half_life_days: entry.half_life_days,
    strength: calculateStrength(entry, now), // derived, never entry.strength (inert-write constraint)
    retrieval_count: entry.retrieval_count,
    outcome_positive: pos,
    outcome_negative: neg,
    outcome_ratio: (pos - neg) / (pos + neg + 1), // same formula as calculateRewardFactor's ratio term
    schema_fit: entry.schema_fit,
    pinned: entry.pinned ? 1 : 0,
    starred: entry.starred ? 1 : 0,
    error_tag: entry.tags.includes('error') ? 1 : 0,
    tag_count: entry.tags.length,
    content_length: entry.content.length,
    dag_level: entry.dag_level,
    ...oneHot('valence', VALENCE_LEVELS, entry.emotional_valence),
    ...oneHot('layer', LAYER_LEVELS, entry.layer),
    ...oneHot('kind', KIND_LEVELS, entry.kind),
    ...oneHot('confidence', CONFIDENCE_LEVELS, entry.confidence),
  };
  // Defensive: every declared feature must be present (catches a future
  // FEATURES list edit that forgets to update this function).
  for (const f of CONFIG.FEATURES) {
    if (!(f in raw)) throw new Error(`computeFeatures: missing declared feature "${f}"`);
  }
  return raw;
}

/**
 * Extract features.jsonl for one already-ingested (and usually simulated)
 * store, joining the gold.json sidecar for the `gold` label.
 * @param {string} questionId
 * @param {string} questionDateIso  the clock to extract at — callers MUST
 *   pass meta.tEval (the causal clock clamp, ingest.mjs), never the raw
 *   meta.questionDate, or memories from haystack sessions postdating the
 *   question can get negative age_days.
 * @returns {{ rows: number, path: string }}
 */
export function extractQuestion(questionId, questionDateIso) {
  const hippoRoot = hippoRootFor(questionId);
  const gold = readJson(goldPathFor(questionId));
  const goldById = new Map(gold.memories.map((m) => [m.id, m.isGold]));
  const provenanceById = new Map(
    gold.memories.map((m) => [m.id, { sessionIndex: m.sessionIndex, turnIdx: m.turnIdx }]),
  );

  setFakeNow(questionDateIso);
  let rows;
  try {
    const entries = loadAllEntries(hippoRoot);
    const now = new Date(questionDateIso);
    rows = entries
      .slice()
      .sort((a, b) => {
        const pa = provenanceById.get(a.id);
        const pb = provenanceById.get(b.id);
        if (!pa || !pb) throw new Error(`extractQuestion: no provenance for memory ${!pa ? a.id : b.id}`);
        return pa.sessionIndex - pb.sessionIndex || pa.turnIdx - pb.turnIdx;
      })
      .map((entry) => {
        const prov = provenanceById.get(entry.id);
        if (!prov) throw new Error(`extractQuestion: no provenance for memory ${entry.id}`);
        return {
          memory_id: entry.id,
          sessionIndex: prov.sessionIndex,
          turnIdx: prov.turnIdx,
          gold: goldById.get(entry.id) === true ? 1 : 0,
          features: computeFeatures(entry, now),
        };
      });
  } finally {
    clearFakeNow();
  }

  const outPath = featuresPathFor(questionId);
  writeJsonl(outPath, rows);
  return { rows: rows.length, path: outPath };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const questionId = flag('question-id');
  if (!questionId) {
    console.error('Usage: extract.mjs --question-id <id>');
    process.exit(2);
  }
  const meta = readJson(metaPathFor(questionId));
  const t0 = Date.now();
  // Causal clock clamp: tEval (not questionDate) — see ingest.mjs header.
  const r = extractQuestion(questionId, meta.tEval);
  console.log(`[extract] ${questionId}: ${r.rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${r.path}`);
}
