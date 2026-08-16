#!/usr/bin/env node
/**
 * Build an eval corpus by asking Claude for realistic paraphrased queries
 * for each memory. Produces harder cases than the keyword-match bootstrap
 * because the queries don't reuse the memory's wording — this is where
 * embeddings and MMR actually earn their keep.
 *
 * Requires ANTHROPIC_API_KEY in env. Uses fetch directly (no SDK dep).
 *
 * Usage:
 *   node scripts/build-eval-corpus-llm.mjs [--max N] [--out PATH]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in env');
  process.exit(1);
}

const MODEL = 'claude-sonnet-4-6';
const MAX_CASES = flagValue('--max', 20);
const OUT_PATH = flagValue('--out', path.join(process.cwd(), 'evals', 'llm-corpus.json'));

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return isNaN(Number(v)) ? v : Number(v);
}

function loadEntries(root) {
  const dbPath = path.join(root, 'hippo.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`
    SELECT id, content, tags_json, layer
    FROM memories
    WHERE length(content) >= 50
    ORDER BY RANDOM()
    LIMIT ?
  `).all(MAX_CASES * 3);
  db.close();
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: JSON.parse(r.tags_json || '[]'),
    layer: r.layer,
  }));
}

async function generateQueriesFor(memory) {
  const prompt = `You are helping build an evaluation corpus for a memory retrieval system.

Given this memory, generate 3 realistic natural-language queries a user might ask where THIS memory would be the ideal answer. The queries should:

- NOT reuse the memory's exact wording (paraphrase)
- Sound like questions a real developer would type
- Test the retrieval system's ability to match meaning, not keywords

Return ONLY a JSON array of 3 strings, no prose. Example format: ["query 1", "query 2", "query 3"]

Memory content:
${memory.content.slice(0, 600)}

Memory tags: ${memory.tags.join(', ') || '(none)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() ?? '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Could not parse JSON array from response: ${text.slice(0, 200)}`);
  const queries = JSON.parse(match[0]);
  if (!Array.isArray(queries) || queries.length === 0) throw new Error('Empty query list');
  return queries.filter(isUsableQuery);
}

/**
 * A generated recall query is only usable when the model actually returned
 * a string long enough to be a real query (parsed LLM JSON is untyped).
 * @param {unknown} q
 * @returns {boolean}
 */
function isUsableQuery(q) {
  return Object.prototype.toString.call(q) === '[object String]' && q.length > 10;
}

async function main() {
  const cwdHippo = path.join(process.cwd(), '.hippo');
  const globalHippo = path.join(os.homedir(), '.hippo');
  const pool = [...loadEntries(cwdHippo), ...loadEntries(globalHippo)];
  if (pool.length === 0) {
    console.error('No memories found in local or global store');
    process.exit(1);
  }

  // Pick the first MAX_CASES after random ordering (loadEntries used ORDER BY RANDOM)
  const chosen = pool.slice(0, MAX_CASES);
  console.error(`Generating queries for ${chosen.length} memories via ${MODEL}...`);

  const cases = [];
  for (let i = 0; i < chosen.length; i++) {
    const m = chosen[i];
    try {
      const queries = await generateQueriesFor(m);
      for (let q = 0; q < queries.length; q++) {
        cases.push({
          id: `llm_${m.id}_${q}`,
          query: queries[q],
          expectedIds: [m.id],
          description: `paraphrased query for ${m.id}`,
        });
      }
      console.error(`  [${i + 1}/${chosen.length}] ${m.id}: +${queries.length} queries`);
    } catch (err) {
      console.error(`  [${i + 1}/${chosen.length}] ${m.id}: FAILED - ${err.message}`);
    }
    // Rate-limit: 1 req/sec so we don't tickle any limits
    await new Promise((r) => setTimeout(r, 1000));
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ cases }, null, 2));
  console.error(`\nWrote ${cases.length} cases (from ${chosen.length} seed memories) to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
