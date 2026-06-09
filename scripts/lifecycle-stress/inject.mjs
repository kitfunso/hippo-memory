#!/usr/bin/env node
/**
 * Held-out, deterministic injector for the lifecycle stress eval (first slice).
 *
 * Emits a time-ordered stream of EPISODIC memories plus a label sidecar.
 * Design constraints (from the pre-reg + the probe's hard-won lesson):
 *   - Each queried fact = `dupesPerFact` near-duplicate memories that share
 *     topic + answer token + a fact-specific filler phrase. WITHIN a fact the
 *     surface forms differ only in a connective word, so pairwise Jaccard
 *     stays >= 0.35 and consolidate() merges the cluster.
 *   - ACROSS facts (and vs distractors) the vocabulary is DISTINCT: a unique
 *     topic, a unique filler, no shared boilerplate. Low cross-cluster overlap
 *     means no spurious cross-fact merge (the probe's lesson: never use shared
 *     phrases like "according to the team").
 *   - The opaque answer token (ANS + digits) sits in the first 120 chars of the
 *     first line, so it survives BOTH merge paths (k=2 keeps the longest
 *     original; k>=3 truncates each bullet to first-line.slice(0,120)).
 *   - Distractors are mutually distinct filler, padded to `scaleMemories`.
 *   - Fully deterministic: a seeded mulberry32 PRNG drives every choice. NO
 *     Math.random, NO Date.now in the content path. Same seed => byte-identical
 *     stream.
 *
 * Labels live ONLY in the sidecar, keyed by an opaque id. hippo never sees them.
 *
 * Run standalone (writes a sidecar + prints the stream as JSON):
 *   node scripts/lifecycle-stress/inject.mjs --seed 1 --scale 100 --facts 6 --dupes 3
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — identical algorithm to benchmarks/.../aggregate.mjs.
// Math.random is BANNED here: it would break stream determinism.
// ---------------------------------------------------------------------------

/** @param {number} seed @returns {() => number} uniform [0,1) */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distinct per-fact vocabulary pools. Each fact draws ONE topic head + ONE
// filler so cross-fact token overlap stays low. Pools are large enough that
// `numFacts` facts get distinct entries for reasonable counts.
const TOPIC_HEADS = [
  'Project Falcon deadline', 'Atlas budget cap', 'Nova release owner',
  'Orion vendor contract', 'Pegasus rollout window', 'Vega staffing plan',
  'Lyra compliance review', 'Draco migration target', 'Cygnus pricing tier',
  'Hydra incident owner', 'Phoenix launch gate', 'Cobra security sign-off',
  'Tucana data retention', 'Mensa latency budget', 'Carina backup cadence',
  'Lynx capacity ceiling',
];
const FILLERS = [
  'engineering milestone fixed during autumn hardware bringup',
  'finance ceiling locked after procurement spreadsheet review',
  'staffing assignment recorded in launch readiness tracker',
  'legal agreement signed following supplier diligence calls',
  'deployment schedule frozen ahead of regional traffic ramp',
  'headcount allocation confirmed by quarterly resourcing board',
  'audit checkpoint cleared once regulator questionnaire returned',
  'cutover target chosen after staging rehearsal dry runs',
  'subscription bracket adjusted from competitor pricing telemetry',
  'response ownership rotated per weekend escalation roster',
  'readiness threshold raised before customer onboarding spike',
  'approval stamp granted post penetration assessment debrief',
  'storage window shortened under tightened privacy mandate',
  'roundtrip allowance trimmed for interactive dashboard paths',
  'snapshot frequency tuned around nightly archival throughput',
  'utilization limit imposed by cluster scheduler quotas',
];

// Distractor vocabulary: ONE large flat pool. Each distractor draws several
// DISTINCT words from it with NO shared template tokens (the earlier
// "Note <i>: the X Y Z for workstream <i>" template shared 4 tokens, so at 10k
// distractors many pairs exceeded the consolidate() Jaccard threshold (0.35) and
// MERGED, making the lifecycle pass measure distractor-summary artifacts). With a
// large pool, several distinct words, and a per-distractor unique salt, any two
// distractors share at most a couple of pool words out of ~8 tokens, so pairwise
// Jaccard stays well below 0.35 and only the intended redundant fact clusters
// merge. Distractors stay realistic semantic noise.
const NOISE_WORDS = [
  'inventory', 'telemetry', 'roadmap', 'changelog', 'rota', 'backlog', 'dashboard',
  'runbook', 'ledger', 'pipeline', 'manifest', 'catalogue', 'workspace', 'notebook',
  'tracker', 'briefing', 'updated', 'archived', 'reviewed', 'circulated', 'reconciled',
  'trimmed', 'annotated', 'reindexed', 'snapshotted', 'rebalanced', 'audited', 'rotated',
  'quarterly', 'regional', 'sprint', 'vendor', 'staffing', 'latency', 'archive', 'access',
  'rollup', 'release', 'survey', 'capacity', 'throughput', 'quota', 'cadence', 'baseline',
  'rollout', 'partition', 'index', 'cursor', 'webhook', 'schema', 'cache', 'queue',
  'metric', 'digest', 'memo', 'addendum', 'footnote', 'appendix', 'sidebar', 'errata',
];

/**
 * Build a deterministic injected stream + labels.
 *
 * @param {{
 *   seed: number,
 *   scaleMemories: number,   // total memory count (facts*dupes + distractors)
 *   numFacts: number,        // queried facts
 *   dupesPerFact: number,    // near-duplicate members per fact (>=2 to merge)
 * }} opts
 * @returns {{
 *   memories: {content: string, tags: string[]}[],
 *   labels: {factKey: string, topic: string, answerToken: string}[],
 * }}
 */
export function injectStream({ seed, scaleMemories, numFacts, dupesPerFact }) {
  if (numFacts > TOPIC_HEADS.length) {
    throw new Error(`numFacts ${numFacts} exceeds distinct topic pool ${TOPIC_HEADS.length}`);
  }
  if (dupesPerFact < 2) {
    throw new Error(`dupesPerFact must be >= 2 (merge needs a cluster), got ${dupesPerFact}`);
  }
  const rng = mulberry32(seed);
  // Opaque answer token: seeded AND GUARANTEED unique per run (resample on
  // collision). Scoring is content.includes(token), so two facts sharing a token
  // would false-credit each other; uniqueness must be enforced, not probable
  // (matters at larger --facts where the 4-digit space collides).
  const usedAns = new Set();
  const ansToken = () => {
    let t;
    do { t = `ANS${1000 + Math.floor(rng() * 9000)}`; } while (usedAns.has(t));
    usedAns.add(t);
    return t;
  };
  // within-fact connectives keep surface variation while preserving high overlap
  const connectives = ['is', 'equals', 'namely', 'set to', 'confirmed as', 'now'];

  /** @type {{content: string, tags: string[]}[]} */
  const memories = [];
  /** @type {{factKey: string, topic: string, answerToken: string}[]} */
  const labels = [];

  // Fact clusters first (oldest). Each fact: a distinct topic + distinct filler.
  for (let f = 0; f < numFacts; f++) {
    const topic = TOPIC_HEADS[f];
    const filler = FILLERS[f % FILLERS.length];
    const ans = ansToken();
    const factKey = `fact${f}`;
    labels.push({ factKey, topic, answerToken: ans });
    for (let d = 0; d < dupesPerFact; d++) {
      // answer token within the first 120 chars of the first line.
      const conn = connectives[d % connectives.length];
      const content = `${topic} ${conn} ${ans}. The ${filler}.`;
      // Tags are EMBEDDED (embeddings.ts:401 embeds `content + tags`), so a per-fact
      // grouping tag would be an oracle signal in the vector. Use a single uniform
      // tag only; fact membership lives in the label sidecar, never in the store.
      memories.push({ content, tags: ['lse'] });
    }
  }

  // Distractors fill to scaleMemories. Each is a per-distractor unique salt token
  // (d<i>) plus 7 DISTINCT words sampled from the flat pool, no shared template.
  // The salt guarantees the token sets always differ; with 7 distinct words from
  // a 60-word pool, two distractors share ~0-2 words out of 8 tokens, so pairwise
  // Jaccard stays far below the 0.35 merge threshold and consolidate() does NOT
  // merge distractors (verified empirically: distractor summaries drop to ~0).
  const usedFactMems = numFacts * dupesPerFact;
  const distractorCount = Math.max(0, scaleMemories - usedFactMems);
  for (let i = 0; i < distractorCount; i++) {
    const picks = new Set();
    while (picks.size < 7) picks.add(NOISE_WORDS[Math.floor(rng() * NOISE_WORDS.length)]);
    const content = `d${i} ${[...picks].join(' ')}.`;
    // Uniform tag only (see fact loop): a shared 'distractor' tag would be embedded
    // and inflate distractor-distractor similarity, nudging spurious merges.
    memories.push({ content, tags: ['lse'] });
  }

  return { memories, labels };
}

/**
 * Write the label sidecar JSON next to a results dir.
 * @param {string} dir
 * @param {object} meta  e.g. {seed, scaleMemories, numFacts, dupesPerFact}
 * @param {{factKey: string, topic: string, answerToken: string}[]} labels
 * @returns {string} the written path
 */
export function writeLabelSidecar(dir, meta, labels) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `labels-seed${meta.seed}-scale${meta.scaleMemories}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta, labels }, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Standalone CLI (debugging aid; the harness imports injectStream directly).
// ---------------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('inject.mjs')) {
  const seed = parseInt(flag('--seed', '1'), 10);
  const scaleMemories = parseInt(flag('--scale', '100'), 10);
  const numFacts = parseInt(flag('--facts', '6'), 10);
  const dupesPerFact = parseInt(flag('--dupes', '3'), 10);
  const { memories, labels } = injectStream({ seed, scaleMemories, numFacts, dupesPerFact });
  console.log(JSON.stringify({
    meta: { seed, scaleMemories, numFacts, dupesPerFact, memoryCount: memories.length },
    labels,
    sample: memories.slice(0, Math.min(memories.length, numFacts * dupesPerFact + 3)),
  }, null, 2));
}
