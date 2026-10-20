// The ambient summary describes the whole visible store, not the rows a query or the no-query cap happened to load.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { Layer, strengthOptionsOf, type EmotionalValence, type MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { contextGet, adminActor } from '../../src/api/index.js';
import {
  renderAmbientSummary,
  tallyAmbientEntries,
  ambientStateFromTallies,
  foldAmbientRows,
} from '../../src/core/ambient.js';
import { cliStore } from '../../src/cli/api-context.js';
import { envRuntimeSettings } from '../../src/util/env.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, writeEntriesTogether, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

let root = '';
let store = '';
let ctx: FullContext;

beforeEach(() => {
  root = makeRoot('ambient-whole', { init: false });
  store = join(root, 'local');
  // An uninitialised global store, so a query reads the local FTS window alone.
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  initTestStore(store);
  ctx = apiCtx(store, 'default', adminActor('test'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('ambient summary over the whole store', () => {
  it('a query matching 2 of 3 memories still reports 3 memories and no false narrow focus', async () => {
    writeEntry(
      store,
      createMemory('always run the migration dry run before deploying', { pinned: true, tags: ['deploy'] }),
    );
    writeEntry(store, createMemory('the deploy pipeline uses blue green rollout for the api', { tags: ['deploy'] }));
    writeEntry(store, createMemory('lunch options near the office include a noodle bar'));

    const result = await contextGet(ctx, { q: 'deploy', currentProject: '' });

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

    const result = await contextGet(ctx, { currentProject: '', budget: 200 });

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
      ...createMemory(`parity row ${i}`, {
        tags: TAGS[i % TAGS.length],
        pinned: i % 11 === 0,
        layer: [Layer.Episodic, Layer.Semantic, Layer.Buffer][i % 3],
      }),
      created,
      lastRetrieved: new Date(Date.parse(created) + (i % 4) * 86400000).toISOString(),
      halfLifeDays: [0, 1, 7, 30][i % 4],
      retrievalCount: i % 5,
      emotionalValence: VALENCES[i % 4],
      outcomePositive: i % 3,
      outcomeNegative: i % 7 === 0 ? 6 : i % 2,
      schemaFit: (i % 10) / 10,
      conflictsWith: i % 6 === 0 ? ['a', 'b'] : [],
      extractedFrom: i % 4 === 1 ? 'src' : null,
      dagLevel: i % 9 === 0 ? 2 : 0,
      supersededBy: i % 13 === 5 ? 'other' : null,
    };
  }

  it.each([
    ['default flags', {}],
    ['decay ablated', { HIPPO_ABLATE_DECAY: '1' }],
    ['recall boost ablated', { HIPPO_ABLATE_RECALL_BOOST: '1' }],
    ['outcome ablated, loss aversion 1.5', { HIPPO_ABLATE_OUTCOME: '1', HIPPO_LOSS_AVERSION_RATIO: '1.5' }],
  ])('%s', async (_label, env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    writeEntriesTogether(
      store,
      Array.from({ length: 60 }, (_, i) => row(i)),
    );
    const db = openHippoDb(store);
    try {
      // A corrupt list must read as empty, as rowToEntry reads it, not fail the aggregate.
      db.prepare(
        `UPDATE memories SET tags_json = '{bad', conflicts_with_json = '{"a":1}' WHERE content = 'parity row 1'`,
      ).run();
    } finally {
      closeHippoDb(db);
    }

    // Both sides score by the ratio the CLI root reads from the environment.
    const sql = await cliStore(store).contextReads.ambientTallies('default', { currentProject: [], now: NOW });
    const js = tallyAmbientEntries([], NOW);
    const live = loadAllEntries(store, 'default').filter((e) => !e.supersededBy);
    foldAmbientRows(js, live, NOW, strengthOptionsOf(envRuntimeSettings()));

    expect({ ...sql, strengthSum: 0 }).toEqual({ ...js, strengthSum: 0 });
    expect(sql.strengthSum).toBeCloseTo(js.strengthSum, 9);
    expect(ambientStateFromTallies(sql).avgStrength).toBeCloseTo(ambientStateFromTallies(js).avgStrength, 9);
  });
});
