#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemory, computeSchemaFit } from '../../dist/entry/memory.js';
import { initStore } from '../../dist/entry/testing.js';
import { writeEntryIn } from '../../dist/store/sqlite/fixtures.js';
import { storeFilesOf } from '../../dist/store/sqlite/runtime/handles.js';
import { RequestStores } from '../../dist/db/index.js';
import {
  parseLmeDate,
  setFakeNow,
  clearFakeNow,
  computeGold,
  questionDir,
  hippoRootFor,
  goldPathFor,
  metaPathFor,
  writeJson,
  safeRemoveScratchDir,
  loadDataset,
} from './common.mjs';

const MIN_CONTENT_LEN = 3;

/**
 * Ingest one question's full haystack into a fresh scratch store.
 * @param {object} question  one LongMemEval question object
 * @returns {{ hippoRoot: string, goldMode: string, goldCount: number, memoryCount: number, skippedEmpty: number }}
 */
export function ingestQuestion(question) {
  const hippoRoot = hippoRootFor(question.question_id);
  safeRemoveScratchDir(questionDir(question.question_id));
  initStore(hippoRoot);

  const { mode, turns } = computeGold(question);
  const questionDateIso = parseLmeDate(question.question_date);

  const sessionDateIso = question.haystack_dates.map(parseLmeDate);
  const tEvalIso = sessionDateIso.reduce((a, b) => (b > a ? b : a), questionDateIso);
  const goldRecords = [];
  let skippedEmpty = 0;
  const session = new RequestStores();
  const files = storeFilesOf(hippoRoot, { session });

  try {
    let currentSessionIdx = -1;
    const entriesSoFar = [];
    for (const t of turns) {
      const content = (t.content ?? '').trim();
      if (content.length < MIN_CONTENT_LEN) {
        skippedEmpty++;
        continue;
      }
      if (t.sessionIndex !== currentSessionIdx) {
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
      writeEntryIn(files, entry);
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
    session.close();
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
    tEval: tEvalIso,
    goldMode: mode,
    goldCount,
    memoryCount: goldRecords.length,
    skippedEmpty,
    sessionCount: question.haystack_sessions.length,
    turns: goldRecords.map((r) => ({ sessionIndex: r.sessionIndex, turnIdx: r.turnIdx, memoryId: r.id })),
  });

  return { hippoRoot, goldMode: mode, goldCount, memoryCount: goldRecords.length, skippedEmpty };
}

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
