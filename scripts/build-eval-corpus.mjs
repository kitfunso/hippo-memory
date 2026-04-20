#!/usr/bin/env node
// Build a realistic eval corpus from the current local+global hippo store.
// Queries are hand-written to simulate what a user would actually ask; the
// expected memory IDs are looked up by keyword match against content.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function loadEntries(root) {
  const dbPath = path.join(root, 'hippo.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id, content, tags_json FROM memories').all();
  db.close();
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: JSON.parse(r.tags_json || '[]'),
  }));
}

function findMatching(entries, { allOf = [], anyOf = [], noneOf = [], maxLen }) {
  return entries.filter((e) => {
    const lc = e.content.toLowerCase();
    // Short-memory filter: canonical rule-style memories are usually concise.
    // Excluding long session summaries that happen to mention the keyword in
    // passing dramatically tightens the corpus.
    if (maxLen !== undefined && e.content.length > maxLen) return false;
    for (const t of allOf) if (!lc.includes(t)) return false;
    if (anyOf.length > 0 && !anyOf.some((t) => lc.includes(t))) return false;
    for (const t of noneOf) if (lc.includes(t)) return false;
    return true;
  }).map((e) => e.id);
}

const cwdHippo = path.join(process.cwd(), '.hippo');
const globalHippo = path.join(os.homedir(), '.hippo');
const localEntries = loadEntries(cwdHippo);
const globalEntries = loadEntries(globalHippo);
const all = [...localEntries, ...globalEntries];

console.error(`loaded ${localEntries.length} local + ${globalEntries.length} global entries`);

// Each case: hand-written query + selector for expected memories.
// maxLen caps content length so we keep canonical rule-style memories and
// exclude long session summaries that mention the keyword in passing.
const caseSpecs = [
  {
    id: 'prod-files-never-overwrite',
    query: 'never overwrite production files keep versioned copies',
    description: 'project rule about prod file safety',
    selector: { allOf: ['never overwrite'], anyOf: ['production'], maxLen: 300 },
  },
  {
    id: 'react-props-rerender',
    query: 'React components re-render when props change',
    description: 'three near-duplicates seeded during QA',
    selector: { allOf: ['react'], anyOf: ['re-render', 'redraw', 're-renders'], maxLen: 200 },
  },
  {
    id: 'direct-user-instructions',
    query: 'when the user gives a direct instruction how should I act',
    description: 'project directive: execute exactly what user asks',
    selector: { allOf: ['direct instruction', 'execute exactly'] },
  },
  {
    id: 'powershell-chaining',
    query: 'PowerShell refuses git command chaining with &&',
    description: 'Windows dev quirk',
    selector: { allOf: ['powershell', '&&'], maxLen: 400 },
  },
  {
    id: 'no-em-dashes',
    query: 'no em dashes in UI text or code',
    description: 'style directive',
    selector: { allOf: ['em dash'], noneOf: ['session 2026'], maxLen: 500 },
  },
  {
    id: 'vitest-runinband',
    query: 'vitest does not accept runInBand in this repo',
    description: 'test infra gotcha',
    selector: { allOf: ['vitest', 'runinband'], maxLen: 400 },
  },
  {
    id: 'gold-tips-inflation',
    query: 'Gold model TIPS inflation signal',
    description: 'quant model spec',
    selector: { allOf: ['gold', 'tips'], anyOf: ['inflation'], maxLen: 400 },
  },
  {
    id: 'shiny-electricity',
    query: 'Shiny electricity market platform Bloomberg terminal',
    description: 'external project reference',
    selector: { allOf: ['shiny'], anyOf: ['electricity market', 'bloomberg terminal'] },
  },
  {
    id: 'pineal-intuition',
    query: 'AI pineal gland intuition awareness module',
    description: 'architecture brainstorm',
    selector: { allOf: ['pineal gland'] },
  },
  {
    id: 'agent-first-pivot',
    query: 'agent-first product direction pivot',
    description: 'recent strategy shift',
    selector: { allOf: ['agent-first', 'pivot'] },
  },
  {
    id: 'bloomberg-parquet',
    query: 'Bloomberg parquet data usage backtesting only',
    description: 'data provenance rule',
    selector: { allOf: ['bloomberg parquet'], maxLen: 500 },
  },
  {
    id: 'quantamental-cta-split',
    query: 'Quantamental and CTA are independent pipelines',
    description: 'architecture rule',
    selector: { allOf: ['quantamental', 'cta'], anyOf: ['independent'], maxLen: 1500 },
  },
  {
    id: 'postgres-vacuum',
    query: 'Postgres VACUUM dead tuples',
    description: 'db maintenance note',
    selector: { allOf: ['vacuum'], anyOf: ['postgres', 'dead tuple'] },
  },
  {
    id: 'contradiction-content-overlap',
    query: 'contradiction detection gated by content overlap',
    description: 'consolidate behavior',
    selector: { allOf: ['contradiction', 'content overlap'], maxLen: 400 },
  },
  {
    id: 'architecture-ideas',
    query: 'novel AI architecture ideas beyond transformers',
    description: 'two canonical brainstorm docs',
    selector: { anyOf: ['pineal gland concept', 'underexplored ai architecture'], maxLen: 6000 },
  },
];

const cases = [];
const orphans = [];
for (const spec of caseSpecs) {
  const expectedIds = findMatching(all, spec.selector);
  if (expectedIds.length === 0) {
    orphans.push(spec.id);
    continue;
  }
  cases.push({
    id: spec.id,
    query: spec.query,
    expectedIds,
    description: spec.description,
  });
}

if (orphans.length > 0) {
  console.error(`WARNING: no matches for ${orphans.length} cases: ${orphans.join(', ')}`);
}

const outPath = process.argv[2] || path.join(process.cwd(), 'evals', 'real-corpus.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ cases }, null, 2));
console.error(`wrote ${cases.length} cases to ${outPath}`);
for (const c of cases) {
  console.error(`  [${c.id}] ${c.expectedIds.length} expected`);
}
