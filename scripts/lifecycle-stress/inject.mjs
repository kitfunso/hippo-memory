#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { mulberry32 } from '../lib/prng.mjs';

const TOPIC_HEADS = [
  'Project Falcon deadline',
  'Atlas budget cap',
  'Nova release owner',
  'Orion vendor contract',
  'Pegasus rollout window',
  'Vega staffing plan',
  'Lyra compliance review',
  'Draco migration target',
  'Cygnus pricing tier',
  'Hydra incident owner',
  'Phoenix launch gate',
  'Cobra security sign-off',
  'Tucana data retention',
  'Mensa latency budget',
  'Carina backup cadence',
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

const NOISE_WORDS = [
  'inventory',
  'telemetry',
  'roadmap',
  'changelog',
  'rota',
  'backlog',
  'dashboard',
  'runbook',
  'ledger',
  'pipeline',
  'manifest',
  'catalogue',
  'workspace',
  'notebook',
  'tracker',
  'briefing',
  'updated',
  'archived',
  'reviewed',
  'circulated',
  'reconciled',
  'trimmed',
  'annotated',
  'reindexed',
  'snapshotted',
  'rebalanced',
  'audited',
  'rotated',
  'quarterly',
  'regional',
  'sprint',
  'vendor',
  'staffing',
  'latency',
  'archive',
  'access',
  'rollup',
  'release',
  'survey',
  'capacity',
  'throughput',
  'quota',
  'cadence',
  'baseline',
  'rollout',
  'partition',
  'index',
  'cursor',
  'webhook',
  'schema',
  'cache',
  'queue',
  'metric',
  'digest',
  'memo',
  'addendum',
  'footnote',
  'appendix',
  'sidebar',
  'errata',
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
  const usedAns = new Set();
  const ansToken = () => {
    let t;
    do {
      t = `ANS${1000 + Math.floor(rng() * 9000)}`;
    } while (usedAns.has(t));
    usedAns.add(t);
    return t;
  };
  const connectives = ['is', 'equals', 'namely', 'set to', 'confirmed as', 'now'];

  /** @type {{content: string, tags: string[]}[]} */
  const memories = [];
  /** @type {{factKey: string, topic: string, answerToken: string}[]} */
  const labels = [];

  for (let f = 0; f < numFacts; f++) {
    const topic = TOPIC_HEADS[f];
    const filler = FILLERS[f % FILLERS.length];
    const ans = ansToken();
    const factKey = `fact${f}`;
    labels.push({ factKey, topic, answerToken: ans });
    for (let d = 0; d < dupesPerFact; d++) {
      const conn = connectives[d % connectives.length];
      const content = `${topic} ${conn} ${ans}. The ${filler}.`;
      memories.push({ content, tags: ['lse'] });
    }
  }

  const usedFactMems = numFacts * dupesPerFact;
  const distractorCount = Math.max(0, scaleMemories - usedFactMems);
  for (let i = 0; i < distractorCount; i++) {
    const picks = new Set();
    while (picks.size < 7) picks.add(NOISE_WORDS[Math.floor(rng() * NOISE_WORDS.length)]);
    const content = `d${i} ${[...picks].join(' ')}.`;
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
  console.log(
    JSON.stringify(
      {
        meta: { seed, scaleMemories, numFacts, dupesPerFact, memoryCount: memories.length },
        labels,
        sample: memories.slice(0, Math.min(memories.length, numFacts * dupesPerFact + 3)),
      },
      null,
      2,
    ),
  );
}
