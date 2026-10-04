// Pins what one sleep reports and leaves behind on a seeded store, stage by stage, so splitting consolidate cannot move it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { appendSessionEvent } from '../src/store/sessions.js';
import { consolidate, type ConsolidationResult } from '../src/consolidate.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;
const dirs: string[] = [];

// config.json sections this file overrides, each a flat map of settings.
type ConfigOverrides = Record<string, Record<string, number | boolean>>;

function newRoot(config: ConfigOverrides): string {
  const root = join(mkdtempSync(join(tmpdir(), 'hippo-sleep-stages-')), '.hippo');
  dirs.push(root);
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify(config), 'utf8');
  return root;
}

function seed(root: string, id: string, text: string, ageDays: number, extra: Partial<MemoryEntry> = {}): void {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  const entry = { ...createMemory(text, { layer: Layer.Episodic }), id, created: at, last_retrieved: at, valid_from: at, ...extra };
  writeEntry(root, entry);
}

function seedStore(root: string): void {
  seed(root, 'mem_keepA', 'the release checklist lives in docs/release.md and covers tagging', 1);
  seed(root, 'mem_keepB', 'vitest shards run on three linux runners in CI', 2);
  seed(root, 'mem_fade', 'an old note about a retired staging hostname nobody uses', 400, { half_life_days: 1 });
  seed(root, 'mem_fadeCred', 'an old note about rotating the staging deploy key', 400, { half_life_days: 1, tags: ['credential'] });
  seed(root, 'mem_pinFade', 'pinned rule about commit message format stays forever', 400, { half_life_days: 1, pinned: true });
  seed(root, 'mem_mergeA', 'the deploy script fails when the staging database migration lock is held', 3);
  seed(root, 'mem_mergeB', 'the deploy script fails when the staging database migration lock is still held', 4);
  seed(root, 'mem_mergeC', 'deploy script fails while the staging database migration lock is held by a job', 5);
  seed(root, 'mem_tabsYes', 'always use tabs for indentation in the hippo repo config files', 6);
  seed(root, 'mem_tabsNo', 'never use tabs for indentation in the hippo repo config files', 7);
}

/** Every number the result carries, plus its detail lines with generated ids and float noise masked. */
function sleepReport(result: ConsolidationResult) {
  const { details, removedIds, ...counts } = result;
  return {
    counts,
    removedIds: [...(removedIds ?? [])].sort(),
    details: details.map((line) => line.replace(/\b[a-z]+_[0-9a-f]{12}\b/g, '<new>').replace(/\d+\.\d{4}/g, '<n>')),
  };
}

function storeRows(root: string) {
  return loadAllEntries(root)
    .map((e) => ({
      id: /^[a-z]+_[0-9a-f]{12}$/.test(e.id) ? '<new>' : e.id,
      layer: e.layer,
      half_life_days: e.half_life_days,
      parents: [...e.parents].sort(),
      content: e.content,
    }))
    .sort((a, b) => (a.id + a.content).localeCompare(b.id + b.content));
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('HIPPO_FAKE_NOW', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('consolidate stage results on a seeded store', () => {
  it('dry run then real run: decay, dormant, delete, replay, merge and conflicts', async () => {
    const root = newRoot({ replay: { count: 2 }, physics: { enabled: false } });
    seedStore(root);

    const dry = await consolidate(root, { dryRun: true, now: NOW });
    expect(sleepReport(dry)).toMatchInlineSnapshot(`
      {
        "counts": {
          "dagCandidateClusters": 0,
          "dagSummariesCreated": 0,
          "decayed": 8,
          "dormant": 1,
          "dormantExpired": 0,
          "dryRun": true,
          "entityProfilesCreated": 0,
          "extracted": 0,
          "extractionCandidates": 8,
          "merged": 5,
          "physicsSimulated": 0,
          "promotedTraces": 0,
          "removed": 1,
          "replayed": 2,
          "semanticCreated": 0,
          "summariesRebuildCapped": false,
          "summariesRebuildFailed": 0,
          "summariesRebuildRefused": 0,
          "summariesRebuilt": 0,
          "summariesZeroChildSkipped": 0,
          "tracesSkippedMixedScope": 0,
        },
        "details": [
          "  💤 dormant mem_fade (strength <n> < 0.05)",
          "  🗑  removed mem_fadeCred (strength <n> < 0.05)",
          "  💭 replayed 2 memories: mem_tabsNo, mem_tabsYes",
          "  🔀 merged 2 episodic entries into semantic: "[Consolidated from 2 related memories, newest first]

      - alwa..."",
          "  🔀 merged 3 episodic entries into semantic: "[Consolidated pattern from 3 related memories, newest first]..."",
        ],
        "removedIds": [
          "mem_fadeCred",
        ],
      }
    `);

    const real = await consolidate(root, { now: NOW });
    expect(sleepReport(real)).toMatchInlineSnapshot(`
      {
        "counts": {
          "dagCandidateClusters": 0,
          "dagSummariesCreated": 0,
          "decayed": 8,
          "dormant": 1,
          "dormantExpired": 0,
          "dryRun": false,
          "entityProfilesCreated": 0,
          "extracted": 0,
          "extractionCandidates": 8,
          "merged": 5,
          "physicsSimulated": 0,
          "promotedTraces": 0,
          "removed": 1,
          "replayed": 2,
          "semanticCreated": 2,
          "summariesRebuildCapped": false,
          "summariesRebuildFailed": 0,
          "summariesRebuildRefused": 0,
          "summariesRebuilt": 0,
          "summariesZeroChildSkipped": 0,
          "tracesSkippedMixedScope": 0,
        },
        "details": [
          "  💤 dormant mem_fade (strength <n> < 0.05)",
          "  🗑  removed mem_fadeCred (strength <n> < 0.05)",
          "  💭 replayed 2 memories: mem_tabsNo, mem_tabsYes",
          "  🔀 merged 2 episodic entries into semantic: "[Consolidated from 2 related memories, newest first]

      - alwa..."",
          "  🔀 merged 3 episodic entries into semantic: "[Consolidated pattern from 3 related memories, newest first]..."",
          "  ⚠️ detected 1 memory conflict",
        ],
        "removedIds": [
          "mem_fadeCred",
        ],
      }
    `);
    expect(storeRows(root)).toMatchInlineSnapshot(`
      [
        {
          "content": "[Consolidated from 2 related memories, newest first]

      - always use tabs for indentation in the hippo repo config files
      - never use tabs for indentation in the hippo repo config files",
          "half_life_days": 365,
          "id": "<new>",
          "layer": "semantic",
          "parents": [
            "mem_tabsNo",
            "mem_tabsYes",
          ],
        },
        {
          "content": "[Consolidated pattern from 3 related memories, newest first]

      - the deploy script fails when the staging database migration lock is held
      - the deploy script fails when the staging database migration lock is still held
      - deploy script fails while the staging database migration lock is held by a job",
          "half_life_days": 365,
          "id": "<new>",
          "layer": "semantic",
          "parents": [
            "mem_mergeA",
            "mem_mergeB",
            "mem_mergeC",
          ],
        },
        {
          "content": "the release checklist lives in docs/release.md and covers tagging",
          "half_life_days": 365,
          "id": "mem_keepA",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "vitest shards run on three linux runners in CI",
          "half_life_days": 365,
          "id": "mem_keepB",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "the deploy script fails when the staging database migration lock is held",
          "half_life_days": 109,
          "id": "mem_mergeA",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "the deploy script fails when the staging database migration lock is still held",
          "half_life_days": 109,
          "id": "mem_mergeB",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "deploy script fails while the staging database migration lock is held by a job",
          "half_life_days": 109,
          "id": "mem_mergeC",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "pinned rule about commit message format stays forever",
          "half_life_days": 1,
          "id": "mem_pinFade",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "never use tabs for indentation in the hippo repo config files",
          "half_life_days": 110,
          "id": "mem_tabsNo",
          "layer": "episodic",
          "parents": [],
        },
        {
          "content": "always use tabs for indentation in the hippo repo config files",
          "half_life_days": 110,
          "id": "mem_tabsYes",
          "layer": "episodic",
          "parents": [],
        },
      ]
    `);
  });

  it('memory-value rescue path and physics pass', async () => {
    const root = newRoot({ replay: { count: 0 }, memoryValue: { enabled: true }, physics: { enabled: true } });
    seedStore(root);
    seed(root, 'mem_fadeUseful', 'release signing steps', 400, {
      half_life_days: 1, outcome_positive: 9, outcome_negative: 9,
    });

    const real = await consolidate(root, { now: NOW });
    expect(sleepReport(real)).toMatchInlineSnapshot(`
      {
        "counts": {
          "dagCandidateClusters": 0,
          "dagSummariesCreated": 0,
          "decayed": 9,
          "dormant": 1,
          "dormantExpired": 0,
          "dryRun": false,
          "entityProfilesCreated": 0,
          "extracted": 0,
          "extractionCandidates": 9,
          "merged": 5,
          "physicsSimulated": 0,
          "promotedTraces": 0,
          "removed": 1,
          "replayed": 0,
          "semanticCreated": 2,
          "summariesRebuildCapped": false,
          "summariesRebuildFailed": 0,
          "summariesRebuildRefused": 0,
          "summariesRebuilt": 0,
          "summariesZeroChildSkipped": 0,
          "tracesSkippedMixedScope": 0,
        },
        "details": [
          "  💤 dormant mem_fade (strength <n> < 0.05)",
          "  🗑  removed mem_fadeCred (strength <n> < 0.05)",
          "  🛟 mem_fadeUseful (strength <n> < 0.05) - rescued (rank 1/10 in tenant default, top 3)",
          "  🔀 merged 2 episodic entries into semantic: "[Consolidated from 2 related memories, newest first]

      - alwa..."",
          "  🔀 merged 3 episodic entries into semantic: "[Consolidated pattern from 3 related memories, newest first]..."",
          "  ⚠️ detected 1 memory conflict",
        ],
        "removedIds": [
          "mem_fadeCred",
        ],
      }
    `);
  });

  it('promotes a completed session to a trace and leaves expired dormant rows alone when retention is off', async () => {
    const root = newRoot({ replay: { count: 0 }, physics: { enabled: false }, dormant: { enabled: true, retentionDays: 0 } });
    appendSessionEvent(root, 'default', { session_id: 'sess-1', event_type: 'step', content: 'ran the migration' });
    appendSessionEvent(root, 'default', { session_id: 'sess-1', event_type: 'step', content: 'checked the lock table' });
    appendSessionEvent(root, 'default', {
      session_id: 'sess-1',
      event_type: 'session_complete',
      content: 'success',
      metadata: { summary: 'unstick the deploy lock' },
    });
    appendSessionEvent(root, 'default', { session_id: 'sess-2', event_type: 'session_complete', content: 'bogus' });

    const real = await consolidate(root, { now: NOW });
    expect(sleepReport(real)).toMatchInlineSnapshot(`
      {
        "counts": {
          "dagCandidateClusters": 0,
          "dagSummariesCreated": 0,
          "decayed": 0,
          "dormant": 0,
          "dormantExpired": 0,
          "dryRun": false,
          "entityProfilesCreated": 0,
          "extracted": 0,
          "extractionCandidates": 0,
          "merged": 0,
          "physicsSimulated": 0,
          "promotedTraces": 1,
          "removed": 0,
          "replayed": 0,
          "semanticCreated": 0,
          "summariesRebuildCapped": false,
          "summariesRebuildFailed": 0,
          "summariesRebuildRefused": 0,
          "summariesRebuilt": 0,
          "summariesZeroChildSkipped": 0,
          "tracesSkippedMixedScope": 0,
        },
        "details": [
          "  🧬 promoted trace <new> from session sess-1 (success)",
          "  🧬 promoted 1 trace from completed session",
        ],
        "removedIds": [],
      }
    `);
    const traces = loadAllEntries(root).filter((e) => e.layer === Layer.Trace);
    expect(traces.map((t) => [t.source_session_id, t.trace_outcome, t.content])).toMatchInlineSnapshot(`
      [
        [
          "sess-1",
          "success",
          "Task: unstick the deploy lock
      Outcome: success
      Steps:
        1. ran the migration
        2. checked the lock table",
        ],
      ]
    `);

    const again = await consolidate(root, { now: NOW });
    expect(again.promotedTraces).toBe(0);
  });
});
