// The ambient summary describes the whole visible store, not the rows a query or the no-query cap happened to load.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry, writeEntryDbOnly } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadAmbientTallies } from '../src/store/ambient.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { Layer, _resetLossAversionRatioCacheForTests, type EmotionalValence, type MemoryEntry } from '../src/memory.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { getContext, adminActor, type Context } from '../src/api.js';
import { renderAmbientSummary, tallyAmbientEntries, ambientStateFromTallies } from '../src/ambient.js';

let root = '';
let store = '';
let ctx: Context;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-ambient-whole-'));
  store = join(root, 'local');
  // An uninitialised global store, so a query reads the local FTS window alone.
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  initStore(store);
  ctx = { hippoRoot: store, tenantId: 'default', actor: adminActor('test') };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('ambient summary over the whole store', () => {
  it('a query matching 2 of 3 memories still reports 3 memories and no false narrow focus', async () => {
    writeEntry(store, createMemory('always run the migration dry run before deploying', { pinned: true, tags: ['deploy'] }));
    writeEntry(store, createMemory('the deploy pipeline uses blue green rollout for the api', { tags: ['deploy'] }));
    writeEntry(store, createMemory('lunch options near the office include a noodle bar'));

    const result = await getContext(ctx, { q: 'deploy', currentProject: '' });

    expect(result.entries).toHaveLength(2);
    expect(result.ambientState?.totalMemories).toBe(3);
    const line = renderAmbientSummary(result.ambientState!);
    expect(line).toContain('3 memories');
    expect(line).not.toContain('narrow focus');
  });

  it('a no-query read of a store past the candidate cap reports its true total', async () => {
    const CAP = 2000;
    const total = CAP + 25;
    const db = openHippoDb(store);
    db.exec('BEGIN');
    try {
      for (let i = 0; i < total; i++) {
        writeEntryDbOnly(db, createMemory(`capped store note ${i} about the build step`, { tags: [`t${i % 7}`] }));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      closeHippoDb(db);
    }

    const result = await getContext(ctx, { currentProject: '', budget: 200 });

    expect(result.ambientState?.totalMemories).toBe(total);
    expect(renderAmbientSummary(result.ambientState!)).toContain(`${total} memories`);
  });
});

describe('SQL ambient tallies match the JS tallies over the same rows', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');
  const VALENCES: EmotionalValence[] = ['neutral', 'positive', 'negative', 'critical'];
  const TAGS = [['error'], ['critical', 'ops'], ['error:db'], ['Error'], ['ops'], [], ['ops', 'ops']];

  function row(i: number): MemoryEntry {
    const created = new Date(NOW.getTime() - (i * 13 + 1) * 3600000).toISOString();
    return {
      ...createMemory(`parity row ${i}`, { tags: TAGS[i % TAGS.length], pinned: i % 11 === 0, layer: [Layer.Episodic, Layer.Semantic, Layer.Buffer][i % 3] }),
      created,
      last_retrieved: new Date(Date.parse(created) + (i % 4) * 86400000).toISOString(),
      half_life_days: [0, 1, 7, 30][i % 4],
      retrieval_count: i % 5,
      emotional_valence: VALENCES[i % 4],
      outcome_positive: i % 3,
      outcome_negative: i % 7 === 0 ? 6 : i % 2,
      schema_fit: (i % 10) / 10,
      conflicts_with: i % 6 === 0 ? ['a', 'b'] : [],
      extracted_from: i % 4 === 1 ? 'src' : null,
      dag_level: i % 9 === 0 ? 2 : 0,
      superseded_by: i % 13 === 5 ? 'other' : null,
    };
  }

  afterEach(() => {
    _resetAblationCacheForTests();
    _resetLossAversionRatioCacheForTests();
  });

  it.each([
    ['default flags', {}],
    ['decay ablated', { HIPPO_ABLATE_DECAY: '1' }],
    ['recall boost ablated', { HIPPO_ABLATE_RECALL_BOOST: '1' }],
    ['outcome ablated, loss aversion 1.5', { HIPPO_ABLATE_OUTCOME: '1', HIPPO_LOSS_AVERSION_RATIO: '1.5' }],
  ])('%s', (_label, env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    _resetAblationCacheForTests();
    _resetLossAversionRatioCacheForTests();
    for (let i = 0; i < 60; i++) writeEntry(store, row(i));
    const db = openHippoDb(store);
    try {
      // A corrupt list must read as empty, as rowToEntry reads it, not fail the aggregate.
      db.prepare(`UPDATE memories SET tags_json = '{bad', conflicts_with_json = '{"a":1}' WHERE content = 'parity row 1'`).run();
    } finally {
      closeHippoDb(db);
    }

    const sql = loadAmbientTallies(store, 'default', { currentProject: [], now: NOW });
    const js = tallyAmbientEntries(loadAllEntries(store).filter((e) => !e.superseded_by), NOW);

    expect({ ...sql, strengthSum: 0 }).toEqual({ ...js, strengthSum: 0 });
    expect(sql.strengthSum).toBeCloseTo(js.strengthSum, 9);
    expect(ambientStateFromTallies(sql).avgStrength).toBeCloseTo(ambientStateFromTallies(js).avgStrength, 9);
  });
});
