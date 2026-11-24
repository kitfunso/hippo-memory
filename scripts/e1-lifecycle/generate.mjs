#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../lib/prng.mjs';

export const GENERATOR_VERSION = '1.0.0';

const ENTITY_HEADS = [
  'Falcon', 'Atlas', 'Nova', 'Orion', 'Pegasus', 'Vega', 'Lyra', 'Draco',
  'Cygnus', 'Hydra', 'Phoenix', 'Cobra', 'Tucana', 'Mensa', 'Carina', 'Lynx',
  'Aquila', 'Corvus', 'Dorado', 'Fornax', 'Gemini', 'Indus', 'Pavo', 'Volans',
];
const ENTITY_UNITS = [
  'pipeline', 'gateway', 'cluster', 'registry', 'scheduler', 'archive',
  'console', 'exporter', 'replicator', 'balancer', 'notifier', 'indexer',
];
const ATTRIBUTES = [
  'deadline', 'budget cap', 'owner', 'vendor contract', 'rollout window',
  'staffing plan', 'compliance review date', 'migration target',
  'pricing tier', 'incident contact', 'launch gate', 'security sign-off',
  'retention period', 'latency budget', 'backup cadence', 'capacity ceiling',
];
const CONNECTIVES = ['is now', 'has been set to', 'was confirmed as', 'stands at', 'moved to'];
const PARAPHRASE_LEADS = [
  'For the record,', 'As noted earlier,', 'Per the old thread,', 'Reminder:',
];
const NEARMISS_QUALIFIERS = [
  'tentatively pencilled near', 'rumoured to be around', 'once floated as',
  'informally guessed at',
];

function valueToken(rand, factIdx, version) {
  const digits = String(Math.floor(rand() * 10000)).padStart(4, '0');
  return `VAL${factIdx}X${version}D${digits}`;
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function shuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {number} [opts.numFacts=300]
 * @param {number} [opts.numSessions=20]
 * @param {number} [opts.distractorMultiple=10]  hard negatives >= multiple * facts
 * @param {string} [opts.baseDate='2025-01-06T09:00:00.000Z']
 * @param {number} [opts.sessionIntervalDays=7]
 * @param {'all'|'v1'} [opts.lookalikeWindow='all']  'v1' dates hard negatives within the sessions v1 can occupy
 */
export function generateProtocol(opts) {
  const seed = opts.seed >>> 0;
  const numFacts = opts.numFacts ?? 300;
  const numSessions = opts.numSessions ?? 20;
  const distractorMultiple = opts.distractorMultiple ?? 10;
  const baseDate = opts.baseDate ?? '2025-01-06T09:00:00.000Z';
  const sessionIntervalDays = opts.sessionIntervalDays ?? 7;
  const lookalikeWindow = opts.lookalikeWindow ?? 'all';
  if (lookalikeWindow !== 'all' && lookalikeWindow !== 'v1') {
    throw new Error(`lookalikeWindow must be 'all' or 'v1', got ${lookalikeWindow}`);
  }
  const rand = mulberry32(seed);

  const baseMs = Date.parse(baseDate);
  const sessions = Array.from({ length: numSessions }, (_, i) => ({
    index: i,
    date: new Date(baseMs + i * sessionIntervalDays * 24 * 60 * 60 * 1000).toISOString(),
  }));

  const pairs = [];
  for (const h of ENTITY_HEADS) for (const u of ENTITY_UNITS) for (const a of ATTRIBUTES) {
    pairs.push({ entity: `${h} ${u}`, attribute: a });
  }
  if (pairs.length < numFacts) throw new Error(`vocab too small: ${pairs.length} < ${numFacts}`);
  const chosen = shuffle(rand, pairs).slice(0, numFacts);

  const memories = [];
  const probes = [];
  const retrievalSchedule = [];
  const outcomeSchedule = [];
  let memSeq = 0;
  const mid = () => `pm${memSeq++}`;

  const order = shuffle(rand, Array.from({ length: numFacts }, (_, i) => i));
  const updateSet = new Set(order.slice(0, Math.round(numFacts * 0.4)));
  const nonUpdated = order.filter((i) => !updateSet.has(i));
  const contraSet = new Set(shuffle(rand, nonUpdated).slice(0, Math.round(numFacts * 0.1)));
  const trapSet = new Set(shuffle(rand, order).slice(0, Math.round(numFacts * 0.15)));

  const recallCounts = chosen.map(() => Math.floor(rand() * 7));
  const sortedCounts = recallCounts.slice().sort((a, b) => b - a);
  const hotThreshold = sortedCounts[Math.max(0, Math.floor(numFacts / 4) - 1)];

  for (let f = 0; f < numFacts; f++) {
    const { entity, attribute } = chosen[f];
    const factId = `F${f}`;
    const s1 = Math.floor(rand() * Math.max(1, Math.floor(numSessions * 0.6)));
    const tok1 = valueToken(rand, f, 1);
    const tokens = { 1: tok1 };
    const versionTimeline = [{ session: s1, version: 1 }];
    memories.push({
      id: mid(), session: s1, kind: 'fact', factId, version: 1,
      content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok1}.`,
      token: tok1,
    });

    if (updateSet.has(f)) {
      const s2 = s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 2));
      const tok2 = valueToken(rand, f, 2);
      tokens[2] = tok2;
      versionTimeline.push({ session: s2, version: 2 });
      memories.push({
        id: mid(), session: s2, kind: 'update', factId, version: 2,
        content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok2}.`,
        token: tok2,
      });
      if (rand() < 0.3 && s2 + 1 < numSessions) {
        const s3 = s2 + 1 + Math.floor(rand() * Math.max(1, numSessions - s2 - 2));
        const tok3 = valueToken(rand, f, 3);
        tokens[3] = tok3;
        versionTimeline.push({ session: Math.min(s3, numSessions - 1), version: 3 });
        memories.push({
          id: mid(), session: Math.min(s3, numSessions - 1), kind: 'update', factId, version: 3,
          content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok3}.`,
          token: tok3,
        });
      }
    }

    const contraTokens = [];
    if (contraSet.has(f)) {
      const sc = Math.min(numSessions - 1, s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 1)));
      const ctok = `CONTRA${f}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
      contraTokens.push(ctok);
      memories.push({
        id: mid(), session: sc, kind: 'contradiction', factId, version: null,
        content: `Heard in passing that ${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ctok}.`,
        token: ctok,
      });
    }

    const trapTokens = [];
    if (trapSet.has(f)) {
      const st = Math.min(numSessions - 1, s1 + Math.floor(rand() * Math.max(1, numSessions - s1)));
      const ttok = `TRAP${f}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
      trapTokens.push(ttok);
      const trapId = mid();
      memories.push({
        id: trapId, session: st, kind: 'trap', factId, version: null,
        content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ttok}.`,
        token: ttok,
      });
      for (let b = 0; b < 2; b++) {
        const so = Math.min(numSessions - 1, st + 1 + b);
        outcomeSchedule.push({ session: so, memoryRef: trapId, good: false });
      }
    }

    const query = `${entity} ${attribute}`;
    const hot = recallCounts[f] >= hotThreshold && recallCounts[f] > 0;
    for (let r = 0; r < recallCounts[f]; r++) {
      const sr = Math.min(numSessions - 1, s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 1)));
      retrievalSchedule.push({ session: sr, query, factId });
    }

    if (rand() < 0.3) {
      const v1Mem = memories.find((m) => m.factId === factId && m.version === 1);
      const so = Math.min(numSessions - 1, s1 + 1);
      outcomeSchedule.push({ session: so, memoryRef: v1Mem.id, good: true });
    }

    probes.push({ factId, query, versionTimeline, tokens, contraTokens, trapTokens, hot });
  }

  const negPerFact = distractorMultiple;
  const negSessions = lookalikeWindow === 'v1' ? Math.max(1, Math.floor(numSessions * 0.6)) : numSessions;
  for (let f = 0; f < numFacts; f++) {
    const { entity, attribute } = chosen[f];
    const probe = probes[f];
    for (let n = 0; n < negPerFact; n++) {
      const family = n % 5;
      const sn = Math.floor(rand() * negSessions);
      const ntok = `NEG${f}N${n}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
      let content;
      if (family === 0) {
        const otherAttr = pick(rand, ATTRIBUTES.filter((a) => a !== attribute));
        content = `${entity} ${otherAttr} ${pick(rand, CONNECTIVES)} ${ntok}.`;
      } else if (family === 1 && probe.tokens[2]) {
        content = `${pick(rand, PARAPHRASE_LEADS)} ${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${probe.tokens[1]}.`;
      } else if (family === 2) {
        content = `${entity} ${attribute} ${pick(rand, NEARMISS_QUALIFIERS)} ${ntok}.`;
      } else if (family === 3) {
        content = `Unconfirmed: ${entity} ${attribute} might be ${ntok}, pending review.`;
      } else {
        content = `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ntok}.`;
      }
      memories.push({
        id: mid(), session: sn, kind: 'distractor', factId: null, version: null,
        content, token: content.includes(probe.tokens[1]) ? probe.tokens[1] : ntok,
      });
    }
  }

  retrievalSchedule.sort((a, b) => a.session - b.session || a.factId.localeCompare(b.factId));
  outcomeSchedule.sort((a, b) => a.session - b.session || a.memoryRef.localeCompare(b.memoryRef));

  return {
    meta: {
      generatorVersion: GENERATOR_VERSION, seed, numFacts, numSessions,
      distractorMultiple, baseDate, sessionIntervalDays,
      // undefined drops out of JSON.stringify, so the default protocol and its hash stay byte-identical.
      lookalikeWindow: lookalikeWindow === 'all' ? undefined : lookalikeWindow,
      counts: {
        memories: memories.length,
        updates: memories.filter((m) => m.kind === 'update').length,
        contradictions: memories.filter((m) => m.kind === 'contradiction').length,
        traps: memories.filter((m) => m.kind === 'trap').length,
        distractors: memories.filter((m) => m.kind === 'distractor').length,
        scheduledRecalls: retrievalSchedule.length,
        outcomes: outcomeSchedule.length,
        hotFacts: probes.filter((p) => p.hot).length,
      },
    },
    sessions, memories, retrievalSchedule, outcomeSchedule, probes,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const seed = Number(getArg('seed', '1'));
  const protocol = generateProtocol({
    seed,
    numFacts: Number(getArg('facts', '300')),
    numSessions: Number(getArg('sessions', '20')),
    distractorMultiple: Number(getArg('distractors', '10')),
    lookalikeWindow: getArg('lookalike-window', 'all'),
  });
  const outDir = getArg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'protocols'));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `protocol-seed${seed}.json`);
  fs.writeFileSync(outFile, JSON.stringify(protocol, null, 1), 'utf8');
  console.log(`wrote ${outFile}`);
  console.log(JSON.stringify(protocol.meta, null, 2));
}
