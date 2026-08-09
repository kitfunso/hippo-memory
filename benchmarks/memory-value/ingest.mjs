#!/usr/bin/env node
/**
 * LC2-E1 — per-question haystack -> scratch hippo store.
 *
 * Per-turn chunking (one MemoryEntry per non-empty haystack turn), matching
 * the plan's "chunk-per-turn precedent". Uses hippo's REAL entry-creation
 * path (createMemory + writeEntry from dist/memory.js + dist/store.js —
 * the same low-level building blocks scripts/e1-lifecycle/run.mjs uses, so
 * `created`/`last_retrieved`/`half_life_days` are stamped exactly as
 * production would). No api.ts / Context layer needed: remember() is a thin
 * wrapper over these same two calls plus an audit-log write we don't need
 * for a scratch, throwaway eval store.
 *
 * Clock convention (pre-reg, pinned): each session's turns are ingested
 * under HIPPO_FAKE_NOW = that session's haystack_date, so `created` varies
 * realistically across the haystack instead of clustering at ingest time.
 *
 * Gold flags: computeGold() (common.mjs) auto-detects evidence-turn vs
 * answer-session-all mode per question and is recorded in gold.json
 * alongside the memory_id <-> turn map, so extract.mjs can join gold labels
 * onto features without ever touching query/answer text itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory, computeSchemaFit } from '../../dist/memory.js';
import { writeEntry, initStore } from '../../dist/store.js';
import {
  parseLmeDate,
  setFakeNow,
  clearFakeNow,
  computeGold,
  hippoRootFor,
  goldPathFor,
  metaPathFor,
  writeJson,
  loadDataset,
} from './common.mjs';

const MIN_CONTENT_LEN = 3; // createMemory's own floor; skip anything shorter (blank/whitespace turns)

/**
 * Ingest one question's full haystack into a fresh scratch store.
 * @param {object} question  one LongMemEval question object
 * @returns {{ hippoRoot: string, goldMode: string, goldCount: number, memoryCount: number, skippedEmpty: number }}
 */
export function ingestQuestion(question) {
  const hippoRoot = hippoRootFor(question.question_id);
  fs.rmSync(path.dirname(hippoRoot), { recursive: true, force: true }); // clean slate per question
  initStore(hippoRoot);

  const { mode, turns } = computeGold(question);
  const questionDateIso = parseLmeDate(question.question_date);

  const sessionDateIso = question.haystack_dates.map(parseLmeDate);
  const goldRecords = [];
  let skippedEmpty = 0;

  try {
    let currentSessionIdx = -1;
    // Real write-time schema_fit (src/cli.ts:740's `computeSchemaFit(text,
    // rawTags, existing)` call, mirrored here). Accumulated in-memory as we
    // go rather than re-querying loadAllEntries(hippoRoot) per turn: the two
    // are numerically identical (computeSchemaFit only reads .tags/.content
    // off each entry) and the in-memory list avoids an O(N^2) DB re-read
    // over a 500+-turn haystack. rawTags is always [] here (see file header
    // — no invented tags), matching production's untagged `hippo remember`.
    const entriesSoFar = [];
    for (const t of turns) {
      const content = (t.content ?? '').trim();
      if (content.length < MIN_CONTENT_LEN) {
        skippedEmpty++;
        continue;
      }
      if (t.sessionIndex !== currentSessionIdx) {
        // Clock convention: stamp created/last_retrieved at this session's
        // real haystack date, one session at a time.
        setFakeNow(sessionDateIso[t.sessionIndex]);
        currentSessionIdx = t.sessionIndex;
      }
      const schemaFit = computeSchemaFit(content, [], entriesSoFar);
      const entry = createMemory(content, {
        kind: 'raw', // these are raw conversation turns, never distilled/summarized
        source: 'longmemeval',
        source_session_id: t.sessionId,
        schema_fit: schemaFit,
      });
      writeEntry(hippoRoot, entry);
      entriesSoFar.push(entry);
      goldRecords.push({
        id: entry.id,
        sessionId: t.sessionId,
        sessionIndex: t.sessionIndex,
        turnIdx: t.turnIdx,
        role: t.role,
        isAnswerSession: t.isAnswerSession,
        isGold: t.isGold,
      });
    }
  } finally {
    clearFakeNow();
  }

  const goldCount = goldRecords.filter((r) => r.isGold).length;
  const goldPath = goldPathFor(question.question_id);
  writeJson(goldPath, {
    questionId: question.question_id,
    goldMode: mode,
    goldCount,
    memoryCount: goldRecords.length,
    memories: goldRecords,
  });

  const metaPath = metaPathFor(question.question_id);
  writeJson(metaPath, {
    questionId: question.question_id,
    questionType: question.question_type,
    questionDate: questionDateIso,
    goldMode: mode,
    goldCount,
    memoryCount: goldRecords.length,
    skippedEmpty,
    sessionCount: question.haystack_sessions.length,
  });

  return { hippoRoot, goldMode: mode, goldCount, memoryCount: goldRecords.length, skippedEmpty };
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
  const dataPath = flag('data');
  const questionId = flag('question-id');
  if (!dataPath) {
    console.error('Usage: ingest.mjs --data <path> [--question-id <id>]');
    process.exit(2);
  }
  const questions = loadDataset(dataPath);
  const targets = questionId ? questions.filter((q) => q.question_id === questionId) : questions;
  if (targets.length === 0) {
    console.error(`No question found${questionId ? ` for id ${questionId}` : ''}.`);
    process.exit(1);
  }
  const t0 = Date.now();
  for (const q of targets) {
    const r = ingestQuestion(q);
    console.log(
      `[ingest] ${q.question_id} (${q.question_type}) -> ${r.memoryCount} memories, ` +
        `gold=${r.goldCount} (${r.goldMode}), skipped=${r.skippedEmpty}`,
    );
  }
  console.log(`[ingest] ${targets.length} question(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
