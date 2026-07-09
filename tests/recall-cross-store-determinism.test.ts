/**
 * Acceptance test for docs/plans/2026-07-09-recall-determinism.md T2/T3:
 * "two fresh identical ingests (different store paths) produce identical
 * top-K recall content sequences." This FAILED on master before T2 (SQLite
 * scan order / crypto.randomUUID() ids decided unbroken score ties; see the
 * plan's "Root cause" section for the empirical probe).
 *
 * Provider-agnostic on purpose: no embedding index is ever saved for either
 * store, so `loadEmbeddingIndex` returns `{}` and hybridSearch's
 * `entries.some((e) => (idx[e.id]?.length ?? 0) > 0)` gate keeps
 * `useEmbeddings` false regardless of whether @xenova/transformers happens
 * to be installed in the test environment — every assertion here exercises
 * the BM25-only path and, specifically, src/compare.ts's tiebreak. The
 * embedding-text-contamination fix (T1, src/embeddings.ts) is unit-tested
 * separately; LoCoMo smoke is the cross-fix integration evidence (plan
 * verify-stage item 4).
 *
 * Real SQLite stores in temp dirs, no mocks (project convention).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { hybridSearch } from '../src/search.js';
import { searchBothHybrid } from '../src/shared.js';

// Fixed clock: pins calculateStrength/recencyBoost so two stores produce
// byte-identical composite scores for byte-identical content — otherwise
// two writes a few real-clock ms apart would introduce a genuine (not
// artifact) score delta and mask what this test exists to catch.
const NOW = new Date('2026-01-15T00:00:00.000Z');

// Content set, inserted in this exact order into BOTH stores:
//   [0] never matches the probe query -> must be excluded from results.
//   [1]..[4] SAME token multiset (anagrams of each other) AND the same
//           pinned timestamp -> identical BM25, strength, and recency, so
//           their composite scores tie EXACTLY. This is the tie the T2
//           comparator must break identically across stores, by content
//           ascending. A GROUP of four (not a pair) so that unmodified
//           master — where the tie falls to random per-store ids — passes
//           the lexicographic-order assertion only with ~1/4! luck per run
//           rather than 1/2 (master is nondeterministic here, so
//           red-on-master is necessarily probabilistic; four items make it
//           overwhelmingly red).
//   [5] matches the probe query but is much longer -> different (lower)
//       BM25 score, giving a non-tied anchor in the ranking.
const CONTENTS = [
  'orbit nebula quasar pulsar filler content wholly unrelated to the probe',
  'zzyzx wombat jackal ocelot signalword',
  'wombat jackal zzyzx ocelot signalword',
  'jackal zzyzx wombat ocelot signalword',
  'ocelot jackal wombat zzyzx signalword',
  'signalword appears here too but this particular document is padded with a great many additional filler words so its length differs substantially from the short tie group above',
];

// The tie group [1..4] in content-ascending order (what compareEntryIdentity
// must produce in BOTH stores regardless of ids):
const TIE_GROUP_SORTED = [CONTENTS[3], CONTENTS[4], CONTENTS[2], CONTENTS[1]].sort();

const QUERY = 'signalword';

/** Per-row timestamp offsets. The anagram tie GROUP [1..4] MUST share the
 *  exact same timestamp: `created`/`last_retrieved` feed calculateStrength and
 *  recencyBoost, so even a 1-second offset makes their composite scores
 *  differ at the ~1e-8 scale — no longer an exact tie, and the stable sort
 *  resolves them by score without ever consulting the comparator. (Review
 *  finding: an earlier version of this fixture used NOW + i*1000 for every
 *  row and PASSED on unmodified master because of exactly that — the
 *  recency delta, not the T2 tiebreak, produced the expected order.
 *  Red-on-master was re-verified after this fix.) */
const TS_OFFSET_MS = [0, 1000, 1000, 1000, 1000, 2000];

/** Ingest CONTENTS in identical order into `root`, tagged with `pathTag`
 *  (mimics cmdRemember's auto path-tag, per the plan's T3 instruction) and
 *  pinned to fixed offsets from NOW so both stores are byte-identical in
 *  every score input, independent of real wall-clock timing. */
function ingestFixture(root: string, pathTag: string): void {
  initStore(root);
  CONTENTS.forEach((content, i) => {
    const entry: MemoryEntry = createMemory(content, {
      layer: Layer.Episodic,
      tags: [pathTag],
    });
    const ts = new Date(NOW.getTime() + TS_OFFSET_MS[i]).toISOString();
    entry.created = ts;
    entry.last_retrieved = ts;
    writeEntry(root, entry);
  });
}

describe('recall cross-store determinism (T2/T3 acceptance)', () => {
  let storeA: string;
  let storeB: string;

  beforeEach(() => {
    // Deliberately DIFFERENT directory name shapes (distinct prefixes AND
    // the mkdtemp-generated random suffix), matching the plan's probe
    // setup: rank variance was traced to store-path-dependent behaviour.
    storeA = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-tiebreak-storeA-'));
    storeB = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-tiebreak-storeB-different-name-'));
    ingestFixture(storeA, 'path:store-a');
    ingestFixture(storeB, 'path:store-b');
  });

  afterEach(() => {
    fs.rmSync(storeA, { recursive: true, force: true });
    fs.rmSync(storeB, { recursive: true, force: true });
  });

  it('hybridSearch returns identical top-K content sequences across differently-named fresh stores', async () => {
    const entriesA = loadAllEntries(storeA);
    const entriesB = loadAllEntries(storeB);
    expect(entriesA.length).toBe(CONTENTS.length);
    expect(entriesB.length).toBe(CONTENTS.length);

    const resultsA = await hybridSearch(QUERY, entriesA, {
      budget: 100_000,
      now: NOW,
      hippoRoot: storeA,
      minResults: 1,
    });
    const resultsB = await hybridSearch(QUERY, entriesB, {
      budget: 100_000,
      now: NOW,
      hippoRoot: storeB,
      minResults: 1,
    });

    const contentsA = resultsA.map((r) => r.entry.content);
    const contentsB = resultsB.map((r) => r.entry.content);

    // The acceptance criterion: identical top-K CONTENT sequences,
    // independent of the store's directory name / per-instance ids.
    expect(contentsA).toEqual(contentsB);

    // The unrelated filler doc never matches the probe query.
    expect(contentsA).not.toContain(CONTENTS[0]);

    // The genuine 4-way tie (anagram group: identical BM25 AND identical
    // pinned timestamps -> exactly equal composite scores) is broken by
    // content ascending in BOTH stores — not by scan order / random id,
    // which would order the group differently across the two
    // independently-created stores (and only match lexicographic order
    // with ~1/24 luck).
    const groupOrderA = contentsA.filter((c) => TIE_GROUP_SORTED.includes(c));
    const groupOrderB = contentsB.filter((c) => TIE_GROUP_SORTED.includes(c));
    expect(groupOrderA).toEqual(TIE_GROUP_SORTED);
    expect(groupOrderB).toEqual(TIE_GROUP_SORTED);
  });

  it('searchBothHybrid returns identical top-K content sequences across differently-named fresh stores', async () => {
    // Empty (non-existent) global root on both sides isolates this to the
    // local-store comparator path (shared.ts) while still exercising the
    // store.ts SQL tiebreaks via loadSearchEntries (FTS/LIKE branches).
    const emptyGlobalA = path.join(os.tmpdir(), 'hippo-tiebreak-no-such-global-a');
    const emptyGlobalB = path.join(os.tmpdir(), 'hippo-tiebreak-no-such-global-b-x');

    const resultsA = await searchBothHybrid(QUERY, storeA, emptyGlobalA, {
      budget: 100_000,
      now: NOW,
      localBump: 1.0, // remove the local-bias multiplier so this mirrors the plain hybridSearch case
    });
    const resultsB = await searchBothHybrid(QUERY, storeB, emptyGlobalB, {
      budget: 100_000,
      now: NOW,
      localBump: 1.0,
    });

    const contentsA = resultsA.map((r) => r.entry.content);
    const contentsB = resultsB.map((r) => r.entry.content);
    expect(contentsA).toEqual(contentsB);
    expect(contentsA.length).toBeGreaterThan(0);
  });
});
