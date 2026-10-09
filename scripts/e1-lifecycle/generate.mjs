#!/usr/bin/env node
/**
 * E1 longitudinal lifecycle protocol — deterministic GENERATOR.
 *
 * Emits the full pre-registered protocol for one seed (PREREGISTERED-DESIGN.md
 * v0.2 + A1, hippo-paper repo): K simulated sessions over calendar time, N
 * version-chained facts (40% receive v2/v3 updates, 10% receive
 * contradictions), HARD negatives only (same-entity/different-attribute,
 * paraphrases of superseded versions, temporal near-misses,
 * contradiction-lookalikes), a scheduled-retrieval plan (drives
 * strengthening; hot facts = top quartile by scheduled recalls), and an
 * outcome schedule with EXPLICIT memory references (never last_retrieval_ids
 * - the strengthen-off arm must keep outcome attribution working) including
 * plausible-but-wrong TRAP memories that receive --bad.
 *
 * Determinism contract (inherited from scripts/lifecycle-stress/inject.mjs):
 * a seeded mulberry32 PRNG drives every choice; NO Math.random, NO Date.now
 * in the content path. Same seed => byte-identical protocol JSON. This file
 * is tagged `e1-generator-freeze` BEFORE any ablation arm is run (anti-bias
 * commitment, design rev #4); changes after the tag = amendment + full re-run.
 * Amendment (docs/evals/2026-09-23-mechanism-audit-round2-prereg.md): opt-in
 * `lookalikeWindow: 'v1'`; the default protocol stays byte-identical (P0 check 1).
 *
 * Value tokens are opaque (VAL<fact><version><digits>) so scoring is by
 * token containment, never by memory id, and a probe can detect WHICH
 * version surfaced (current vs superseded vs contradiction vs trap).
 *
 * Run standalone:  node scripts/e1-lifecycle/generate.mjs --seed 1 [--facts 300] [--sessions 20] [--lookalike-window all|v1]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../lib/prng.mjs';

export const GENERATOR_VERSION = '1.0.0';

// --------------------------------------------------------------------------
// Vocabulary pools. Compound entities = HEAD x UNIT product (>= 288 distinct),
// each fact draws a UNIQUE (entity, attribute) pair; cross-fact token overlap
// stays low by construction (distinct entity tokens dominate each content).
// --------------------------------------------------------------------------

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
// Connectives vary surface form between versions/paraphrases (low-signal words).
const CONNECTIVES = ['is now', 'has been set to', 'was confirmed as', 'stands at', 'moved to'];
const PARAPHRASE_LEADS = [
  'For the record,', 'As noted earlier,', 'Per the old thread,', 'Reminder:',
];
const NEARMISS_QUALIFIERS = [
  'tentatively pencilled near', 'rumoured to be around', 'once floated as',
  'informally guessed at',
];

/** Deterministic opaque value token: VAL + factIdx + version + 4 seeded digits. */
function valueToken(rand, factIdx, version) {
  const digits = String(Math.floor(rand() * 10000)).padStart(4, '0');
  return `VAL${factIdx}X${version}D${digits}`;
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/** Fisher-Yates with the seeded PRNG. */
function shuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --------------------------------------------------------------------------
// Generator
// --------------------------------------------------------------------------

function newBook() {
  return {
    /** @type {any[]} { id, session, kind, factId, version, content, token } */
    memories: [],
    /** @type {any[]} { factId, query, versionTimeline, tokens, trapTokens, contraTokens, hot } */
    probes: [],
    /** @type {any[]} { session, query, factId } */
    retrievalSchedule: [],
    /** @type {any[]} { session, memoryRef, good } */
    outcomeSchedule: [],
    memSeq: 0,
  };
}

function mid(book) {
  return `pm${book.memSeq++}`;
}

/** Sessions with simulated dates (weekly cadence by default). */
function buildSessions(numSessions, baseDate, sessionIntervalDays) {
  const baseMs = Date.parse(baseDate);
  return Array.from({ length: numSessions }, (_, i) => ({
    index: i,
    date: new Date(baseMs + i * sessionIntervalDays * 24 * 60 * 60 * 1000).toISOString(),
  }));
}

/** Unique (entity, attribute) per fact. */
function chooseFactPairs(rand, numFacts) {
  const pairs = [];
  for (const h of ENTITY_HEADS) for (const u of ENTITY_UNITS) for (const a of ATTRIBUTES) {
    pairs.push({ entity: `${h} ${u}`, attribute: a });
  }
  if (pairs.length < numFacts) throw new Error(`vocab too small: ${pairs.length} < ${numFacts}`);
  return shuffle(rand, pairs).slice(0, numFacts);
}

/**
 * Which facts get updates (40%) and contradictions (10%). Fractions are
 * exact (shuffled-slice draws, not stochastic) and the two sets are
 * DISJOINT: contradictions sample from the NON-updated remainder, so
 * contradiction-intrusion is never confounded with version chains
 * (codex P2: the earlier draw re-sampled the full list and could overlap).
 */
function drawFactSets(rand, numFacts) {
  const order = shuffle(rand, Array.from({ length: numFacts }, (_, i) => i));
  const updateSet = new Set(order.slice(0, Math.round(numFacts * 0.4)));
  const nonUpdated = order.filter((i) => !updateSet.has(i));
  const contraSet = new Set(shuffle(rand, nonUpdated).slice(0, Math.round(numFacts * 0.1)));
  // Traps: 15% of facts get one plausible-but-wrong memory that receives --bad.
  const trapSet = new Set(shuffle(rand, order).slice(0, Math.round(numFacts * 0.15)));
  return { updateSet, contraSet, trapSet };
}

/** Recall frequency per fact (0..6, seeded). Hot = top quartile. */
function drawRecallCounts(rand, numFacts) {
  const recallCounts = Array.from({ length: numFacts }, () => Math.floor(rand() * 7));
  const sortedCounts = recallCounts.slice().sort((a, b) => b - a);
  const hotThreshold = sortedCounts[Math.max(0, Math.floor(numFacts / 4) - 1)];
  return { recallCounts, hotThreshold };
}

/** Adds v1 (and the v2/v3 chain when the fact is updated) to the book; returns the first session, tokens and timeline. */
function addFactVersions(rand, book, numSessions, fact, hasUpdate) {
  const { f, factId, entity, attribute } = fact;
  // v1 lands in the first 60% of sessions so updates have room afterwards.
  const s1 = Math.floor(rand() * Math.max(1, Math.floor(numSessions * 0.6)));
  const tok1 = valueToken(rand, f, 1);
  const tokens = { 1: tok1 };
  const versionTimeline = [{ session: s1, version: 1 }];
  book.memories.push({
    id: mid(book), session: s1, kind: 'fact', factId, version: 1,
    content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok1}.`,
    token: tok1,
  });

  // Version chain: v2 (and possibly v3) at strictly later sessions.
  if (hasUpdate) {
    const s2 = s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 2));
    const tok2 = valueToken(rand, f, 2);
    tokens[2] = tok2;
    versionTimeline.push({ session: s2, version: 2 });
    book.memories.push({
      id: mid(book), session: s2, kind: 'update', factId, version: 2,
      content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok2}.`,
      token: tok2,
    });
    if (rand() < 0.3 && s2 + 1 < numSessions) {
      const s3 = s2 + 1 + Math.floor(rand() * Math.max(1, numSessions - s2 - 2));
      const tok3 = valueToken(rand, f, 3);
      tokens[3] = tok3;
      versionTimeline.push({ session: Math.min(s3, numSessions - 1), version: 3 });
      book.memories.push({
        id: mid(book), session: Math.min(s3, numSessions - 1), kind: 'update', factId, version: 3,
        content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${tok3}.`,
        token: tok3,
      });
    }
  }
  return { s1, tokens, versionTimeline };
}

/**
 * Contradiction: asserts a WRONG value at a later session; never becomes
 * current truth (adversarial noise; secondary intrusion metric).
 */
function addContradiction(rand, book, numSessions, fact, s1) {
  const { f, factId, entity, attribute } = fact;
  const sc = Math.min(numSessions - 1, s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 1)));
  const ctok = `CONTRA${f}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
  book.memories.push({
    id: mid(book), session: sc, kind: 'contradiction', factId, version: null,
    content: `Heard in passing that ${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ctok}.`,
    token: ctok,
  });
  return [ctok];
}

/**
 * Trap: plausible-but-wrong memory that the outcome schedule marks --bad
 * (twice). Trap-persistence = its token still in top-5 afterwards.
 */
function addTrap(rand, book, numSessions, fact, s1) {
  const { f, factId, entity, attribute } = fact;
  const st = Math.min(numSessions - 1, s1 + Math.floor(rand() * Math.max(1, numSessions - s1)));
  const ttok = `TRAP${f}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
  const trapId = mid(book);
  book.memories.push({
    id: trapId, session: st, kind: 'trap', factId, version: null,
    content: `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ttok}.`,
    token: ttok,
  });
  for (let b = 0; b < 2; b++) {
    const so = Math.min(numSessions - 1, st + 1 + b);
    book.outcomeSchedule.push({ session: so, memoryRef: trapId, good: false });
  }
  return [ttok];
}

/** Scheduled mutating recalls (strengthening drivers), spread over sessions AFTER the fact first exists. */
function addScheduledRecalls(rand, book, numSessions, fact, s1, query, count) {
  for (let r = 0; r < count; r++) {
    const sr = Math.min(numSessions - 1, s1 + 1 + Math.floor(rand() * Math.max(1, numSessions - s1 - 1)));
    book.retrievalSchedule.push({ session: sr, query, factId: fact.factId });
  }
}

/** Positive outcomes: 30% of facts' v1 memory gets one --good. */
function addGoodOutcome(rand, book, numSessions, factId, s1) {
  if (rand() < 0.3) {
    const v1Mem = book.memories.find((m) => m.factId === factId && m.version === 1);
    const so = Math.min(numSessions - 1, s1 + 1);
    book.outcomeSchedule.push({ session: so, memoryRef: v1Mem.id, good: true });
  }
}

/** Text of one hard negative; the family decides the template, and each draws only the values it needs. */
function hardNegativeContent(rand, family, entity, attribute, probe, ntok) {
  if (family === 0) {
    // same-entity / DIFFERENT-attribute
    const otherAttr = pick(rand, ATTRIBUTES.filter((a) => a !== attribute));
    return `${entity} ${otherAttr} ${pick(rand, CONNECTIVES)} ${ntok}.`;
  }
  if (family === 1 && probe.tokens[2]) {
    // paraphrase of a SUPERSEDED version (carries the OLD token: surfacing
    // it after the update counts as stale-intrusion - intentional)
    return `${pick(rand, PARAPHRASE_LEADS)} ${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${probe.tokens[1]}.`;
  }
  if (family === 2) {
    // temporal near-miss
    return `${entity} ${attribute} ${pick(rand, NEARMISS_QUALIFIERS)} ${ntok}.`;
  }
  if (family === 3) {
    // contradiction-lookalike (hedged phrasing, own token)
    return `Unconfirmed: ${entity} ${attribute} might be ${ntok}, pending review.`;
  }
  // VALUE-CLAIM lookalike (pilot-2 rescale, 2026-06-11): the EXACT fact
  // template with its own token. Pilot 2 showed longer meta-sentences
  // never displace tight fact docs (BM25 length normalization), so the
  // all-off ceiling held at 0.967. Identical-form claims are also the
  // realistic adversary: a long-lived store accumulates multiple tight
  // value claims per key (old notes, speculation, misheard values).
  // With > top-k identical-form docs per fact, a static ranker must
  // tie-break arbitrarily; lifecycle signals (update recency,
  // strengthening, outcomes) are precisely the tiebreakers under test.
  return `${entity} ${attribute} ${pick(rand, CONNECTIVES)} ${ntok}.`;
}

/**
 * Hard negatives (>= distractorMultiple x facts), four template families.
 * Each carries its own opaque NEG token so it can never satisfy a probe.
 */
function addHardNegatives(rand, book, chosen, numSessions, lookalikeWindow, negPerFact) {
  // One draw per negative either way, so 'v1' keeps every token and only moves sessions.
  const negSessions = lookalikeWindow === 'v1' ? Math.max(1, Math.floor(numSessions * 0.6)) : numSessions;
  for (let f = 0; f < chosen.length; f++) {
    const { entity, attribute } = chosen[f];
    const probe = book.probes[f];
    for (let n = 0; n < negPerFact; n++) {
      const family = n % 5;
      const sn = Math.floor(rand() * negSessions);
      const ntok = `NEG${f}N${n}D${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
      const content = hardNegativeContent(rand, family, entity, attribute, probe, ntok);
      book.memories.push({
        id: mid(book), session: sn, kind: 'distractor', factId: null, version: null,
        content, token: content.includes(probe.tokens[1]) ? probe.tokens[1] : ntok,
      });
    }
  }
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

  const sessions = buildSessions(numSessions, baseDate, sessionIntervalDays);
  const chosen = chooseFactPairs(rand, numFacts);
  const book = newBook();
  const { updateSet, contraSet, trapSet } = drawFactSets(rand, numFacts);
  const { recallCounts, hotThreshold } = drawRecallCounts(rand, numFacts);

  for (let f = 0; f < numFacts; f++) {
    const fact = { f, factId: `F${f}`, ...chosen[f] };
    const { s1, tokens, versionTimeline } = addFactVersions(rand, book, numSessions, fact, updateSet.has(f));
    const contraTokens = contraSet.has(f) ? addContradiction(rand, book, numSessions, fact, s1) : [];
    const trapTokens = trapSet.has(f) ? addTrap(rand, book, numSessions, fact, s1) : [];
    const query = `${fact.entity} ${fact.attribute}`;
    const hot = recallCounts[f] >= hotThreshold && recallCounts[f] > 0;
    addScheduledRecalls(rand, book, numSessions, fact, s1, query, recallCounts[f]);
    addGoodOutcome(rand, book, numSessions, fact.factId, s1);
    book.probes.push({ factId: fact.factId, query, versionTimeline, tokens, contraTokens, trapTokens, hot });
  }

  addHardNegatives(rand, book, chosen, numSessions, lookalikeWindow, distractorMultiple);

  // Stable ordering within each session: by id sequence (already insertion-
  // ordered); the driver ingests session-by-session.
  const { memories, probes, retrievalSchedule, outcomeSchedule } = book;
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

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
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
