// A typed object's mirror memory is stored as it was before the Objects store group took the save: on the flat half-life until the typed
// migration has run and on the configured default after, with the strength the decay function gives the stored row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { saveCustomerNote } from '../src/objects/customer-notes.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { saveDecision } from '../src/objects/decisions.js';
import { saveIncident } from '../src/objects/incidents.js';
import { calculateStrength, deriveHalfLife, type MemoryEntry } from '../src/core/memory.js';
import { savePolicy } from '../src/objects/policies.js';
import { saveProcess } from '../src/objects/processes.js';
import { saveProjectBrief } from '../src/objects/project-briefs.js';
import { saveSkill } from '../src/objects/skills.js';
import { readEntry } from '../src/store/entry-reads.js';
import { initStore, LEGACY_TYPED_HALF_LIFE, TYPED_HALF_LIFE_META_KEY } from '../src/store/open.js';

const FROZEN = new Date('2026-03-01T12:00:00.000Z');
const TENANT = 'acme';
const ACTOR = 'api_key:caller';
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh store has the typed migration marked done; `migrated: false` takes the mark away, as a store made before the migration has it. */
function storeWith(migrated: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-mirror-half-life-'));
  roots.push(root);
  initStore(root);
  if (migrated) return root;
  const db = openHippoDb(root);
  try {
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(TYPED_HALF_LIFE_META_KEY);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

function saveOneOfEach(root: string): void {
  saveDecision(root, TENANT, { decisionText: 'ship on fridays', context: 'release train' }, ACTOR);
  saveIncident(root, TENANT, { incidentText: 'checkout latency', context: 'eu-west', extraTags: ['error'] }, ACTOR);
  saveProcess(root, TENANT, { processName: 'deploy', steps: ['build', 'ship'], description: 'weekly' }, ACTOR);
  savePolicy(root, TENANT, { policyName: 'retention', policyText: 'keep ninety days', validFrom: '2026-01-01' }, ACTOR);
  saveSkill(root, TENANT, { skillName: 'triage', instructions: 'read the log first', trigger: 'on page' }, ACTOR);
  saveProjectBrief(root, TENANT, { repo: 'acme/web', summary: 'storefront', extraTags: ['path:acme/web'] }, ACTOR);
  saveCustomerNote(root, TENANT, { customer: 'initech', note: 'prefers email' }, ACTOR);
}

type Column = string | number | null;

/** Every column but id, which is random, and updated_at, which SQLite stamps from its own clock. */
function mirrorRows(root: string): Record<string, Column>[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: a memories row holds only text, numbers and NULL.
    const rows = db.prepare(`SELECT * FROM memories ORDER BY source`).all() as Record<string, Column>[];
    return rows.map(({ id: _id, updated_at: _stamped, ...columns }) => columns);
  } finally {
    closeHippoDb(db);
  }
}

// The rows below were read from a store written by the commit before the group, under the same frozen clock and the same seven saves.
const SHARED = {
  created: '2026-03-01T12:00:00.000Z', last_retrieved: '2026-03-01T12:00:00.000Z', retrieval_count: 0, strength: 1, layer: 'semantic', schema_fit: 0.5,
  outcome_score: null, conflicts_with_json: '[]', pinned: 0, confidence: 'verified', outcome_positive: 0, outcome_negative: 0, parents_json: '[]', starred: 0,
  trace_outcome: null, source_session_id: null, valid_from: '2026-03-01T12:00:00.000Z', superseded_by: null, extracted_from: null, dag_level: 0, dag_parent_id: null,
  kind: 'distilled', scope: null, owner: null, artifact_ref: null, tenant_id: 'acme', descendant_count: 0, earliest_at: null, latest_at: null, summary_dirty: 0,
  last_rebuilt_at: null, rebuild_count: 0, dag_level_3_built_at: null, origin_project: '',
} as const;

/** What differs from row to row, in source order; `flat` is the half-life before the typed migration and `onDefault` the one after. */
const OWN = [
  { source: 'customer_note', tags_json: '["customer_note","customer:initech"]', emotional_valence: 'neutral', content: 'initech\n\nprefers email', flat: 90, onDefault: 365 },
  { source: 'decision', tags_json: '["decision"]', emotional_valence: 'neutral', content: 'ship on fridays\n\nContext: release train', flat: 90, onDefault: 365 },
  { source: 'incident', tags_json: '["incident","error"]', emotional_valence: 'negative', content: 'checkout latency\n\nContext: eu-west', flat: 180, onDefault: 730 },
  { source: 'policy', tags_json: '["policy"]', emotional_valence: 'neutral', content: 'retention\n\nkeep ninety days\n\nEffective: 2026-01-01T00:00:00.000Z onward', flat: 90, onDefault: 365 },
  { source: 'process', tags_json: '["process"]', emotional_valence: 'neutral', content: 'deploy\n\n1. build\n2. ship\n\nDescription: weekly', flat: 90, onDefault: 365 },
  { source: 'project_brief', tags_json: '["project_brief","path:acme/web"]', emotional_valence: 'neutral', content: 'acme/web\n\nstorefront', flat: 90, onDefault: 365 },
  { source: 'skill', tags_json: '["skill"]', emotional_valence: 'neutral', content: 'triage\n\nWhen: on page\n\nread the log first', flat: 90, onDefault: 365 },
] as const;

function rowsBeforeTheGroup(migrated: boolean): Record<string, Column>[] {
  return OWN.map(({ flat, onDefault, ...own }) => ({ ...SHARED, ...own, half_life_days: migrated ? onDefault : flat }));
}

/** A clock that moves one millisecond at every read, so no two reads inside a save agree; it returns the instants it handed out. */
function stubTickingClock(): number[] {
  const ticks: number[] = [];
  const next = (): number => {
    ticks.push(FROZEN.getTime() + ticks.length);
    return ticks[ticks.length - 1];
  };
  // The proxy reads `now` off the real Date, so the spy covers both ways of asking the time.
  vi.spyOn(Date, 'now').mockImplementation(next);
  const ticking = new Proxy(Date, { construct: (target, args: unknown[]): Date => (args.length === 0 ? new target(next()) : Reflect.construct(target, args)) });
  vi.stubGlobal('Date', ticking);
  return ticks;
}

interface TickedSave {
  readonly memoryId: string | null;
  /** The instants the clock handed out while the save ran. */
  readonly reads: readonly number[];
}

function ticked(ticks: readonly number[], save: () => { memoryId: string | null }): TickedSave {
  const from = ticks.length;
  const { memoryId } = save();
  return { memoryId, reads: ticks.slice(from) };
}

function storedMirror(root: string, save: TickedSave): MemoryEntry {
  const stored = save.memoryId === null ? null : readEntry(root, save.memoryId, TENANT);
  if (stored === null) throw new Error('the save left no mirror');
  return stored;
}

describe.each([
  { flag: 'unset', migrated: false },
  { flag: 'set', migrated: true },
])('a typed object saved with the typed half-life flag $flag', ({ migrated }) => {
  it('stores each kind\'s mirror column for column as the commit before the store group did', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });
    const root = storeWith(migrated);
    saveOneOfEach(root);
    expect(mirrorRows(root)).toEqual(rowsBeforeTheGroup(migrated));
  });

  it('under a clock that ticks, stores the strength the decay function gives the stored row at one of the save\'s own clock reads', () => {
    const root = storeWith(migrated);
    const base = migrated ? loadConfig(root).defaultHalfLifeDays : LEGACY_TYPED_HALF_LIFE;
    const ticks = stubTickingClock();
    const saves = [
      ticked(ticks, () => saveIncident(root, TENANT, { incidentText: 'checkout latency' }, ACTOR)),
      ticked(ticks, () => saveDecision(root, TENANT, { decisionText: 'ship on fridays' }, ACTOR)),
      ticked(ticks, () => saveIncident(root, TENANT, { incidentText: 'login errors', extraTags: ['error'] }, ACTOR)),
    ];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    const mirrors = saves.map((save) => storedMirror(root, save));
    expect(mirrors.map((m) => m.half_life_days)).toEqual([base, base, base * 2]);
    const readsGiving = (i: number): number[] => saves[i].reads.filter((at) => calculateStrength(mirrors[i], new Date(at)) === mirrors[i].strength);
    for (const [i, stored] of mirrors.entries()) {
      expect(stored.half_life_days).toBe(deriveHalfLife(base, stored));
      expect(readsGiving(i).length).toBeGreaterThan(0);
    }
    for (const i of [0, 1]) {
      // One read, later than the one that stamped the row: the clock did tick inside the save, so the strength is not the 1.0 of a frozen clock.
      expect(readsGiving(i)).toHaveLength(1);
      expect(readsGiving(i)[0]).toBeGreaterThan(Date.parse(mirrors[i].created));
      expect(mirrors[i].strength).toBeLessThan(1);
    }
    // An error tag lifts the strength over the cap of 1, so every read gives that mirror the same value.
    expect(readsGiving(2)).toEqual(saves[2].reads);
  });
});
