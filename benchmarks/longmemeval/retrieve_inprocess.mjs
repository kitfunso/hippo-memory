#!/usr/bin/env node
/**
 * In-process LongMemEval retrieval. Avoids the 500x subprocess + model-load
 * tax of shelling out to `hippo recall`. Imports hippo's search functions
 * directly so the embedding model is loaded once.
 *
 * Output matches retrieve.py JSONL schema for downstream evaluate_retrieval.py.
 *
 * Usage:
 *   node retrieve_inprocess.mjs --data data/longmemeval_oracle.json --store-dir hippo_store2 --output results/retrieval_v27.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hybridSearch, buildCorpus } from '../../dist/search.js';
import { loadAllEntries } from '../../dist/store.js';

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const DATA_PATH = flag('--data', 'data/longmemeval_oracle.json');
const STORE_DIR = flag('--store-dir', 'hippo_store2');
const OUTPUT_PATH = flag('--output', 'results/retrieval_v27.jsonl');
const BUDGET = parseInt(flag('--budget', '4000'), 10);
const LIMIT = parseInt(flag('--limit', '0'), 10);

const hippoRoot = path.resolve(STORE_DIR, '.hippo');
if (!fs.existsSync(hippoRoot)) {
  console.error(`Store not found: ${hippoRoot}`);
  process.exit(1);
}

console.error(`Loading entries from ${hippoRoot}...`);
const entries = loadAllEntries(hippoRoot);
console.error(`  ${entries.length} memories`);

console.error('Pre-building BM25 corpus (one-time)...');
const cStart = Date.now();
const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
console.error(`  corpus ready in ${Date.now() - cStart}ms`);

console.error(`Loading dataset ${DATA_PATH}...`);
const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const questions = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);
console.error(`  ${questions.length} questions${LIMIT > 0 ? ` (limit ${LIMIT})` : ''}`);

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
// Truncate + use sync appendFileSync so progress is always visible on disk —
// buffered streams made it look like the job was stuck earlier.
fs.writeFileSync(OUTPUT_PATH, '');
function writeLine(obj) {
  fs.appendFileSync(OUTPUT_PATH, JSON.stringify(obj) + '\n');
}

const start = Date.now();
const limit = LIMIT > 0 ? Math.min(LIMIT, questions.length) : questions.length;
let empty = 0;

for (let i = 0; i < limit; i++) {
  const q = questions[i];
  const question = q.question ?? '';
  try {
    const results = await hybridSearch(question, entries, {
      budget: BUDGET,
      hippoRoot,
      preparedCorpus: corpus,
    });
    const memories = results.map((r) => ({
      id: r.entry.id,
      score: r.score,
      strength: r.entry.strength,
      tags: r.entry.tags,
      content: r.entry.content,
      tokens: r.tokens,
    }));
    if (memories.length === 0) empty++;
    const record = {
      question_id: q.question_id,
      question,
      answer: q.answer ?? '',
      question_type: q.question_type ?? '',
      question_date: q.question_date ?? '',
      retrieved_memories: memories,
      num_retrieved: memories.length,
    };
    writeLine(record);
  } catch (err) {
    console.error(`  [${i}] ${q.question_id} FAILED: ${err.message}`);
    const record = {
      question_id: q.question_id,
      question,
      answer: q.answer ?? '',
      question_type: q.question_type ?? '',
      question_date: q.question_date ?? '',
      retrieved_memories: [],
      num_retrieved: 0,
      error: err.message,
    };
    writeLine(record);
    empty++;
  }
  if ((i + 1) % 25 === 0 || i === limit - 1) {
    const elapsed = (Date.now() - start) / 1000;
    const rate = (i + 1) / elapsed;
    const eta = (limit - i - 1) / rate;
    console.error(`  ${i + 1}/${limit}  ${rate.toFixed(1)}/s  ETA ${eta.toFixed(0)}s  empty=${empty}`);
  }
}

const totalSec = (Date.now() - start) / 1000;
console.error(`Done in ${totalSec.toFixed(1)}s. ${limit} queries, ${empty} empty, output: ${OUTPUT_PATH}`);
