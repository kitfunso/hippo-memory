#!/usr/bin/env node
// diff_orderings.mjs — Gate-A diff script for F9 LLM-rerank evaluation.
// Compares ordered memory ids between two retrieval JSONL files.
// Reports how many questions have differing orderings.
// Exit 0 = Gate-A PASS (diff >= 250); Exit 1 = FAIL.
import * as fs from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('Usage: node diff_orderings.mjs <baseline.jsonl> <reranked.jsonl>');
  process.exit(2);
}

const linesA = fs.readFileSync(a, 'utf8').trim().split('\n').map(JSON.parse);
const linesB = fs.readFileSync(b, 'utf8').trim().split('\n').map(JSON.parse);

const byId = new Map(linesA.map(r => [r.question_id, r]));

// Extract ordered memory ids from a retrieval entry.
// Supports: retrieved_memory_ids (flat array) OR retrieved_memories[].id
function getOrderedIds(entry) {
  if (Array.isArray(entry.retrieved_memory_ids)) {
    return entry.retrieved_memory_ids;
  }
  if (Array.isArray(entry.retrieved_memories)) {
    return entry.retrieved_memories.map(m => m.id);
  }
  return [];
}

let diff = 0, same = 0;
for (const rb of linesB) {
  const ra = byId.get(rb.question_id);
  if (!ra) continue;
  const idsA = getOrderedIds(ra).join(',');
  const idsB = getOrderedIds(rb).join(',');
  if (idsA === idsB) same++; else diff++;
}

const total = diff + same;
console.log(`differing orderings: ${diff} / ${total}`);
process.exit(diff >= 250 ? 0 : 1); // exit 0 = Gate-A PASS
