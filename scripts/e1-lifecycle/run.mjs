#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createMemory, applyOutcome } from '../../dist/entry/memory.js';
import { initStore } from '../../dist/entry/testing.js';
import { loadAllEntriesIn, writeEntryIn } from '../../dist/store/sqlite/fixtures.js';
import { storeFilesOf } from '../../dist/store/sqlite/runtime/handles.js';
import { withSharedStoreHandles } from '../../dist/db/index.js';
import { hybridSearch } from '../../dist/entry/eval-scripts.js';
import { outcomeMultiplier } from '../../dist/entry/eval-scripts.js';
import { markRetrieved } from '../../dist/entry/memory.js';
import { isRecallBoostAblated, evalNow as _resetAblationCacheForTests } from '../../dist/entry/eval-scripts.js';
import { generateProtocol, GENERATOR_VERSION } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'benchmarks', 'e1-lifecycle', 'raw');
let SWEEP_HALF_LIFE = 7;
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

function currentAt(probe, epoch) {
  let cur = null;
  for (const step of probe.versionTimeline) {
    if (step.session <= epoch) cur = step;
  }
  return cur;
}

const PROBE_TOP_K = 5;
const PROBE_BUDGET = 100000;

const byId = (a, b) => a.entry.id.localeCompare(b.entry.id);
const BASELINE_RANKERS = {
  'bm25-static': (a, b) => (b.bm25 - a.bm25) || byId(a, b),
  'bm25-outcome': (a, b) => (b.bm25 * outcomeMultiplier(b.entry) - a.bm25 * outcomeMultiplier(a.entry)) || byId(a, b),
  'bm25-newest': (a, b) => (b.bm25 - a.bm25) || (Date.parse(b.entry.created) - Date.parse(a.entry.created)) || byId(a, b),
};

async function probeTopEntries(probe, entries, arm, probeNow) {
  if (arm === 'recency-window') {
    return entries.slice().sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, PROBE_TOP_K);
  }
  const results = await hybridSearch(probe.query, entries, { budget: PROBE_BUDGET, now: probeNow, minResults: PROBE_TOP_K });
  const ranked = BASELINE_RANKERS[arm] ? results.slice().sort(BASELINE_RANKERS[arm]) : results;
  return ranked.slice(0, PROBE_TOP_K).map((r) => r.entry);
}

async function probeEpoch(protocol, entries, epoch, epochDate, arm) {
  const probeNow = new Date(Date.parse(epochDate) + 60 * 60 * 1000);
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

    const top = await probeTopEntries(probe, entries, arm, probeNow);
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
    cleanStaleR5: staleEligible > 0 ? cleanStale / staleEligible : null,
    nonStaleActive, nonStaleR5: nonStaleActive > 0 ? nonStaleCurrent5 / nonStaleActive : null,
    probes,
  };
}

function groupBySession(items) {
  const bySession = new Map();
  for (const item of items) {
    if (!bySession.has(item.session)) bySession.set(item.session, []);
    bySession.get(item.session).push(item);
  }
  return bySession;
}

function ingestMemories(files, seed, memories, idMap) {
  for (const m of memories) {
    const entry = createMemory(m.content, { baseHalfLifeDays: SWEEP_HALF_LIFE });
    entry.id = `mem_${createHash('sha256').update(`e1:${seed}:${m.id}`).digest('hex').slice(0, 12)}`;
    writeEntryIn(files, entry);
    idMap.set(m.id, entry.id);
  }
}

async function runScheduledRetrievals(files, retrievals) {
  const entriesNow = () => loadAllEntriesIn(files);
  for (const r of retrievals) {
    const entries = entriesNow();
    const results = await hybridSearch(r.query, entries, { budget: PROBE_BUDGET, minResults: PROBE_TOP_K });
    const topEntries = results.slice(0, PROBE_TOP_K).map((x) => x.entry);
    const updated = markRetrieved(topEntries);
    if (!isRecallBoostAblated()) {
      for (const u of updated) writeEntryIn(files, u);
    }
  }
}

function applyScheduledOutcomes(files, outcomes, idMap, sessionIndex) {
  for (const o of outcomes) {
    const hippoId = idMap.get(o.memoryRef);
    if (!hippoId) throw new Error(`outcome before ingestion: ${o.memoryRef} at session ${sessionIndex}`);
    const entry = loadAllEntriesIn(files).find((e) => e.id === hippoId);
    if (!entry) throw new Error(`outcome target missing from store: ${hippoId}`);
    const updated = applyOutcome(entry, o.good);
    writeEntryIn(files, updated);
  }
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

    const idMap = new Map();
    const bySession = groupBySession(protocol.memories);
    const retrievalsBySession = groupBySession(protocol.retrievalSchedule);
    const outcomesBySession = groupBySession(protocol.outcomeSchedule);

    // One connection for the whole arm: a close per write checkpoints the WAL, which is slow on Windows.
    await withSharedStoreHandles(async (handles) => {
      const files = storeFilesOf(hippoRoot, { session: handles });
      for (const session of protocol.sessions) {
        setSimulatedNow(session.date);
        ingestMemories(files, seed, bySession.get(session.index) ?? [], idMap);
        await runScheduledRetrievals(files, retrievalsBySession.get(session.index) ?? []);
        applyScheduledOutcomes(files, outcomesBySession.get(session.index) ?? [], idMap, session.index);

        const entries = loadAllEntriesIn(files);
        epochs.push(await probeEpoch(protocol, entries, session.index, session.date, arm));
      }
    });
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
