#!/usr/bin/env node
/**
 * E1 longitudinal lifecycle protocol — the DRIVER.
 *
 * Executes the pre-registered protocol (PREREGISTERED-DESIGN.md v0.2 + A1)
 * for each requested (arm x seed): builds a HERMETIC fresh store (temp
 * HIPPO_HOME, cleaned up after), walks the K simulated sessions in order,
 * and probes READ-ONLY after every session.
 *
 * Mutation/measurement split (design rev #3):
 *   - MUTATORS (the only state writers): session ingestion
 *     (createMemory+writeEntry under HIPPO_FAKE_NOW), scheduled retrievals
 *     (hybridSearch -> markRetrieved -> persistence gated EXACTLY like the
 *     CLI: skipped when isRecallBoostAblated()), and outcome applications
 *     (applyOutcome+writeEntry on EXPLICIT protocol-mapped ids - never
 *     last_retrieval_ids).
 *   - PROBES are in-process hybridSearch calls with an explicit `now`; no
 *     markRetrieved, no writes. (retrieve_inprocess.mjs pattern.)
 *
 * Simulated time: HIPPO_FAKE_NOW env + _resetAblationCacheForTests() per
 * session (in-process equivalent of one process per session). createMemory /
 * markRetrieved / scoring all honor it via evalNow().
 *
 * Arms (env per design section 3; baselines rank differently in the prober):
 *   full            no flags
 *   decay-off       HIPPO_ABLATE_DECAY=1            (A1: co-ablates outcome-slow + read-side boost)
 *   strengthen-off  HIPPO_ABLATE_RECALL_BOOST=1
 *   outcome-off     HIPPO_ABLATE_OUTCOME=1
 *   all-off         all three
 *   bm25-static     all three + probe ranks by raw BM25 component only
 *   recency-window  all three + probe returns the 5 newest entries
 *   Round 2 (docs/evals/2026-09-23-mechanism-audit-round2-prereg.md):
 *   recency-off     HIPPO_ABLATE_RECENCY=1          (the search recency factor only)
 *   bm25-outcome    all off but the fast outcome channel + probe ranks by raw BM25 x outcomeMultiplier
 *   bm25-newest     all three + probe ranks by raw BM25, ties newest first
 *   Flags: --recency-days <n> sets the recency scale; --lookalike-window v1 dates
 *   hard negatives within v1's sessions (both recorded in meta).
 *
 * NO sleep/consolidation in E1 (that is E3's dimension); no embeddings (the
 * lexical+lifecycle composite exercises every mechanism under test; the
 * embedding blend is orthogonal to the ablations).
 *
 * Run (pilot):  node scripts/e1-lifecycle/run.mjs --arms full,all-off --seeds 1 --facts 300
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createMemory, applyOutcome } from '../../dist/memory.js';
import { writeEntry, loadAllEntries, initStore } from '../../dist/store.js';
import { hybridSearch, markRetrieved, outcomeMultiplier } from '../../dist/search.js';
import { isRecallBoostAblated, _resetAblationCacheForTests } from '../../dist/ablation.js';
import { generateProtocol, GENERATOR_VERSION } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'benchmarks', 'e1-lifecycle', 'raw');
// Half-life robustness sweep (amendment A5, EXPLORATORY - not in the frozen prereg).
// Module-level so the CLI can vary the decay half-life without changing runArmSeed's
// signature: probe-replay.mjs imports runArmSeed and relies on the default 7d, which
// reproduces the registered E1 byte-identically (invariant-tested).
let SWEEP_HALF_LIFE = 7;
// Round-2 tuning grid: the search recency scale in days; null keeps the product's 30.
let SWEEP_RECENCY_DAYS = null;

const ARM_ENV = {
  'full': {},
  'decay-off': { HIPPO_ABLATE_DECAY: '1' },
  'strengthen-off': { HIPPO_ABLATE_RECALL_BOOST: '1' },
  'outcome-off': { HIPPO_ABLATE_OUTCOME: '1' },
  'all-off': { HIPPO_ABLATE_DECAY: '1', HIPPO_ABLATE_RECALL_BOOST: '1', HIPPO_ABLATE_OUTCOME: '1' },
  'bm25-static': { HIPPO_ABLATE_DECAY: '1', HIPPO_ABLATE_RECALL_BOOST: '1', HIPPO_ABLATE_OUTCOME: '1' },
  'recency-window': { HIPPO_ABLATE_DECAY: '1', HIPPO_ABLATE_RECALL_BOOST: '1', HIPPO_ABLATE_OUTCOME: '1' },
  'recency-off': { HIPPO_ABLATE_RECENCY: '1' },
  'bm25-outcome': { HIPPO_ABLATE_DECAY: '1', HIPPO_ABLATE_RECALL_BOOST: '1', HIPPO_ABLATE_OUTCOME_SLOW: '1' },
  'bm25-newest': { HIPPO_ABLATE_DECAY: '1', HIPPO_ABLATE_RECALL_BOOST: '1', HIPPO_ABLATE_OUTCOME: '1' },
};
const ABLATION_VARS = ['HIPPO_ABLATE_DECAY', 'HIPPO_ABLATE_RECALL_BOOST', 'HIPPO_ABLATE_OUTCOME', 'HIPPO_ABLATE_OUTCOME_SLOW', 'HIPPO_ABLATE_OUTCOME_FAST', 'HIPPO_ABLATE_RECENCY', 'HIPPO_EVAL_RECENCY_DAYS', 'HIPPO_FAKE_NOW'];

function setArmEnv(arm) {
  for (const v of ABLATION_VARS) delete process.env[v];
  for (const [k, val] of Object.entries(ARM_ENV[arm])) process.env[k] = val;
  if (SWEEP_RECENCY_DAYS !== null) process.env.HIPPO_EVAL_RECENCY_DAYS = String(SWEEP_RECENCY_DAYS);
  _resetAblationCacheForTests();
}

function setSimulatedNow(iso) {
  process.env.HIPPO_FAKE_NOW = iso;
  _resetAblationCacheForTests();
}

/** Current version token for a probe at epoch e, or null if fact not yet live. */
function currentAt(probe, epoch) {
  let cur = null;
  for (const step of probe.versionTimeline) {
    if (step.session <= epoch) cur = step;
  }
  return cur; // { session, version } | null
}

const PROBE_TOP_K = 5;
const PROBE_BUDGET = 100000; // token budget never binds at top-5 granularity

const byId = (a, b) => a.entry.id.localeCompare(b.entry.id);
const BASELINE_RANKERS = {
  'bm25-static': (a, b) => (b.bm25 - a.bm25) || byId(a, b),
  'bm25-outcome': (a, b) => (b.bm25 * outcomeMultiplier(b.entry) - a.bm25 * outcomeMultiplier(a.entry)) || byId(a, b),
  'bm25-newest': (a, b) => (b.bm25 - a.bm25) || (Date.parse(b.entry.created) - Date.parse(a.entry.created)) || byId(a, b),
};

async function probeEpoch(protocol, entries, epoch, epochDate, arm) {
  const probeNow = new Date(Date.parse(epochDate) + 60 * 60 * 1000); // +1h after session
  let active = 0, current5 = 0, staleEligible = 0, staleHit = 0;
  let trapEligible = 0, trapHit = 0, contraEligible = 0, contraHit = 0;
  let hotActive = 0, hotCurrent5 = 0, mrrSum = 0;
  let cleanStale = 0, nonStaleActive = 0, nonStaleCurrent5 = 0;
  const probes = [];

  for (const probe of protocol.probes) {
    const cur = currentAt(probe, epoch);
    if (!cur) continue;
    active++;
    if (probe.hot) hotActive++;

    let top;
    if (arm === 'recency-window') {
      top = entries.slice().sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, PROBE_TOP_K);
    } else {
      const results = await hybridSearch(probe.query, entries, { budget: PROBE_BUDGET, now: probeNow, minResults: PROBE_TOP_K });
      // Baseline tie-breaks MUST be independent of the composite order: a
      // bare stable sort would let identical-BM25 candidates (this protocol
      // creates many) keep hybridSearch's lifecycle/recency-tinged ordering
      // (codex P2). Entry id is deterministic (seed-derived) and content-blind.
      const ranked = BASELINE_RANKERS[arm] ? results.slice().sort(BASELINE_RANKERS[arm]) : results;
      top = ranked.slice(0, PROBE_TOP_K).map((r) => r.entry);
    }
    const texts = top.map((e) => e.content);
    const curTok = probe.tokens[cur.version];
    const rank = texts.findIndex((t) => t.includes(curTok));
    const row = {
      factId: probe.factId, hot: !!probe.hot, hit: rank >= 0, rank, staleEligible: cur.version >= 2, staleHit: false,
      trapEligible: false, trapHit: false, contraEligible: false, contraHit: false,
    };
    if (rank >= 0) {
      current5++;
      if (probe.hot) hotCurrent5++;
      mrrSum += 1 / (rank + 1);
    }
    // Stale intrusion: only meaningful once an update has superseded v1.
    if (row.staleEligible) {
      staleEligible++;
      const staleToks = Object.entries(probe.tokens)
        .filter(([v]) => Number(v) < cur.version).map(([, t]) => t);
      row.staleHit = texts.some((t) => staleToks.some((s) => t.includes(s)));
      if (row.staleHit) staleHit++;
      else if (rank >= 0) cleanStale++;
    } else {
      nonStaleActive++;
      if (rank >= 0) nonStaleCurrent5++;
    }
    if (probe.trapTokens.length > 0) {
      // Eligible once the trap memory exists in the store.
      const trapLive = entries.some((e) => probe.trapTokens.some((t) => e.content.includes(t)));
      if (trapLive) {
        trapEligible++;
        row.trapEligible = true;
        row.trapHit = texts.some((t) => probe.trapTokens.some((tt) => t.includes(tt)));
        if (row.trapHit) trapHit++;
      }
    }
    if (probe.contraTokens.length > 0) {
      const contraLive = entries.some((e) => probe.contraTokens.some((t) => e.content.includes(t)));
      if (contraLive) {
        contraEligible++;
        row.contraEligible = true;
        row.contraHit = texts.some((t) => probe.contraTokens.some((ct) => t.includes(ct)));
        if (row.contraHit) contraHit++;
      }
    }
    probes.push(row);
  }

  return {
    epoch, activeProbes: active,
    currentR5: active > 0 ? current5 / active : null,
    mrr: active > 0 ? mrrSum / active : null,
    staleEligible, staleIntrusionRate: staleEligible > 0 ? staleHit / staleEligible : null,
    trapEligible, trapPersistenceRate: trapEligible > 0 ? trapHit / trapEligible : null,
    contraEligible, contraIntrusionRate: contraEligible > 0 ? contraHit / contraEligible : null,
    hotActive, hotR5: hotActive > 0 ? hotCurrent5 / hotActive : null,
    // Split for the break-even superseded share (2026-09-23 mechanism audit prereg).
    cleanStaleR5: staleEligible > 0 ? cleanStale / staleEligible : null,
    nonStaleActive, nonStaleR5: nonStaleActive > 0 ? nonStaleCurrent5 / nonStaleActive : null,
    probes,
  };
}

/**
 * @param {string} arm
 * @param {number} seed
 * @param {object} [genOpts]  forwarded to generateProtocol
 * @param {(hippoRoot: string, idMap: Map<string,string>) => Promise<void>|void} [inspect]
 *   test hook: called with the live store path AFTER the last epoch, BEFORE
 *   cleanup (invariant tests assert on real DB state).
 */
export async function runArmSeed(arm, seed, genOpts = {}, inspect = undefined) {
  const protocol = generateProtocol({ seed, ...genOpts });
  const protocolHash = createHash('sha256').update(JSON.stringify(protocol)).digest('hex').slice(0, 16);

  const hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hippo-e1-${arm}-s${seed}-`));
  const epochs = [];
  try {
    setArmEnv(arm);
    setSimulatedNow(protocol.sessions[0].date);
    initStore(hippoRoot);

    const idMap = new Map(); // protocol memory id -> hippo entry (latest object)
    const bySession = new Map();
    for (const m of protocol.memories) {
      if (!bySession.has(m.session)) bySession.set(m.session, []);
      bySession.get(m.session).push(m);
    }
    const retrievalsBySession = new Map();
    for (const r of protocol.retrievalSchedule) {
      if (!retrievalsBySession.has(r.session)) retrievalsBySession.set(r.session, []);
      retrievalsBySession.get(r.session).push(r);
    }
    const outcomesBySession = new Map();
    for (const o of protocol.outcomeSchedule) {
      if (!outcomesBySession.has(o.session)) outcomesBySession.set(o.session, []);
      outcomesBySession.get(o.session).push(o);
    }

    for (const session of protocol.sessions) {
      setSimulatedNow(session.date); // mutators stamp simulated time

      // 1. Ingest this session's memories (created/last_retrieved = fake now).
      //    Entry ids are DERIVED from (seed, protocol id), not random UUIDs:
      //    the protocol intentionally creates score TIES (identical-form
      //    negatives), and same-timestamp rows order by id - random ids would
      //    make identical (arm, seed) runs produce different top-5 metrics
      //    (codex P1). sha256 prefix keeps the mem_<12 hex> format.
      for (const m of bySession.get(session.index) ?? []) {
        const entry = createMemory(m.content, { baseHalfLifeDays: SWEEP_HALF_LIFE });
        entry.id = `mem_${createHash('sha256').update(`e1:${seed}:${m.id}`).digest('hex').slice(0, 12)}`;
        writeEntry(hippoRoot, entry);
        idMap.set(m.id, entry.id);
      }

      // 2. Scheduled mutating retrievals - CLI-parity block: hybridSearch ->
      //    markRetrieved -> persistence gated exactly like cli.ts cmdRecall.
      const entriesNow = () => loadAllEntries(hippoRoot);
      for (const r of retrievalsBySession.get(session.index) ?? []) {
        const entries = entriesNow();
        const results = await hybridSearch(r.query, entries, { budget: PROBE_BUDGET, minResults: PROBE_TOP_K });
        const topEntries = results.slice(0, PROBE_TOP_K).map((x) => x.entry);
        const updated = markRetrieved(topEntries); // default now = evalNow() (fake)
        if (!isRecallBoostAblated()) {
          for (const u of updated) writeEntry(hippoRoot, u);
        }
      }

      // 3. Scheduled outcomes on EXPLICIT ids (never last_retrieval_ids).
      for (const o of outcomesBySession.get(session.index) ?? []) {
        const hippoId = idMap.get(o.memoryRef);
        if (!hippoId) throw new Error(`outcome before ingestion: ${o.memoryRef} at session ${session.index}`);
        const entry = loadAllEntries(hippoRoot).find((e) => e.id === hippoId);
        if (!entry) throw new Error(`outcome target missing from store: ${hippoId}`);
        const updated = applyOutcome(entry, o.good);
        writeEntry(hippoRoot, updated);
      }

      // 4. READ-ONLY probes (explicit now; no markRetrieved; no writes).
      const entries = loadAllEntries(hippoRoot);
      epochs.push(await probeEpoch(protocol, entries, session.index, session.date, arm));
    }
    // Only the final epoch is judged, so only it keeps per-probe rows (compare.mjs hierarchical CI).
    for (const e of epochs.slice(0, -1)) delete e.probes;

    if (inspect) await inspect(hippoRoot, idMap);
  } finally {
    for (const v of ABLATION_VARS) delete process.env[v];
    _resetAblationCacheForTests();
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  }

  return {
    meta: {
      arm, seed, generatorVersion: GENERATOR_VERSION, protocolHash,
      protocolCounts: protocol.meta.counts, ranAt: new Date().toISOString(),
      halfLife: SWEEP_HALF_LIFE,
      recencyDays: SWEEP_RECENCY_DAYS ?? undefined,
      lookalikeWindow: protocol.meta.lookalikeWindow,
    },
    epochs,
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
  const arms = getArg('arms', 'full,all-off').split(',').map((s) => s.trim()).filter(Boolean);
  const seeds = getArg('seeds', '1').split(',').flatMap((s) => {
    const m = s.match(/^(\d+)-(\d+)$/);
    return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(s)];
  });
  const genOpts = {
    numFacts: Number(getArg('facts', '300')),
    numSessions: Number(getArg('sessions', '20')),
    distractorMultiple: Number(getArg('distractors', '10')),
  };
  // A5 sweep: --half-life sets the decay base (default 7 = registered E1); --out-dir
  // isolates sweep output so it never clobbers the registered raw/.
  SWEEP_HALF_LIFE = Number(getArg('half-life', '7'));
  const recencyDays = getArg('recency-days', null);
  if (recencyDays !== null && !(Number.isFinite(Number(recencyDays)) && Number(recencyDays) > 0)) {
    console.error(`--recency-days must be a positive number, got ${recencyDays}`);
    process.exit(1);
  }
  SWEEP_RECENCY_DAYS = recencyDays === null ? null : Number(recencyDays);
  const lookalikeWindow = getArg('lookalike-window', null);
  if (lookalikeWindow !== null) genOpts.lookalikeWindow = lookalikeWindow;
  const outDir = path.resolve(getArg('out-dir', OUT_DIR));
  for (const arm of arms) {
    if (!ARM_ENV[arm]) {
      console.error(`unknown arm: ${arm}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  (async () => {
    for (const arm of arms) {
      for (const seed of seeds) {
        const t0 = Date.now();
        const result = await runArmSeed(arm, seed, genOpts);
        const outFile = path.join(outDir, `${arm}-seed${seed}.json`);
        fs.writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
        const last = result.epochs[result.epochs.length - 1];
        console.log(
          `${arm} seed=${seed} done in ${((Date.now() - t0) / 1000).toFixed(1)}s | final epoch: ` +
          `R@5=${last.currentR5?.toFixed(3)} stale=${last.staleIntrusionRate?.toFixed(3)} ` +
          `trap=${last.trapPersistenceRate?.toFixed(3)} hot=${last.hotR5?.toFixed(3)}`
        );
      }
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
