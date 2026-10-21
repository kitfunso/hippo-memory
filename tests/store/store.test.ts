import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  loadSearchEntries,
  writeEntry,
  readEntry,
  loadAllEntries,
  updateStats,
  saveActiveTaskSnapshot,
  appendSessionEvent,
} from '../_helpers/root-forms.js';
import { flushHeldMirrors } from '../../src/store/sqlite/mirrors.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import {
  openHippoDb,
  closeHippoDb,
  isFtsAvailable,
  getSchemaVersion,
  getCurrentSchemaVersion,
} from '../../src/db/index.js';
import { Layer } from '../../src/base/memory/memory.js';
import { consolidate } from '../../src/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  deleteEntry,
  loadLastRecall,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  listSessionEvents,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyFixtureRoot = path.join(__dirname, '..', 'fixtures', 'legacy-markdown-store');

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('test', { init: false });
});

describe('store initialization', () => {
  it('creates a SQLite database backbone for new stores', () => {
    initTestStore(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'hippo.db'))).toBe(true);
  });

  it('imports the explicit legacy markdown fixture into SQLite on first init', () => {
    fs.cpSync(legacyFixtureRoot, tmpDir, { recursive: true });

    initTestStore(tmpDir);

    const alpha = readEntry(tmpDir, 'mem_legacy_alpha');
    const beta = readEntry(tmpDir, 'mem_legacy_beta');

    expect(alpha).not.toBeNull();
    expect(alpha!.content).toContain('Legacy markdown alpha memory');
    expect(alpha!.tags).toEqual(['legacy', 'block-list', 'migration']);
    expect(alpha!.conflictsWith).toEqual(['mem_legacy_beta']);

    expect(beta).not.toBeNull();
    expect(beta!.tags).toEqual(['legacy', 'semantic', 'fixture']);
    expect(beta!.conflictsWith).toEqual(['mem_legacy_alpha']);
    expect(beta!.pinned).toBe(true);

    expect(loadLastRecall(tmpDir).last_retrieval_ids).toEqual(['mem_legacy_alpha', 'mem_legacy_beta']);

    // SAFETY: reports.stats()' Record<string, unknown> return is buildStatsFromDb's fixed
    // stats-mirror shape (src/store/mirrors.ts), which always includes these counter fields.
    const stats = sqliteSyncStore(tmpDir).reports.stats() as {
      total_remembered: number;
      total_recalled: number;
      total_forgotten: number;
      consolidation_runs: Array<{ timestamp: string; decayed: number; merged: number; removed: number }>;
    };
    expect(stats.total_remembered).toBe(7);
    expect(stats.total_recalled).toBe(11);
    expect(stats.total_forgotten).toBe(2);
    expect(stats.consolidation_runs).toEqual([
      {
        timestamp: '2026-03-03T08:00:00.000Z',
        decayed: 4,
        merged: 1,
        removed: 2,
      },
    ]);

    expect(
      loadAllEntries(tmpDir, 'default')
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['mem_legacy_alpha', 'mem_legacy_beta']);
  });

  it('fails safe on a corrupt SQLite file and preserves legacy markdown source', () => {
    fs.cpSync(legacyFixtureRoot, tmpDir, { recursive: true });

    const legacyPath = path.join(tmpDir, 'episodic', 'mem_legacy_alpha.md');
    const originalRaw = fs.readFileSync(legacyPath, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'hippo.db'), 'definitely not sqlite', 'utf8');

    expect(() => initTestStore(tmpDir)).toThrow();
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(originalRaw);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('tracks schema version through the migration scaffold', () => {
    initTestStore(tmpDir);

    const db = openHippoDb(tmpDir);
    try {
      expect(getSchemaVersion(db)).toBe(getCurrentSchemaVersion());
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('remember + recall round-trip', () => {
  it('writes a memory and reads it back intact', () => {
    initTestStore(tmpDir);

    const entry = createMemory('FRED cache silently dropped TIPS', {
      tags: ['error', 'data-pipeline'],
      layer: Layer.Episodic,
    });

    writeEntry(tmpDir, entry);

    const loaded = readEntry(tmpDir, entry.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(entry.id);
    expect(loaded!.content).toBe('FRED cache silently dropped TIPS');
    expect(loaded!.tags).toContain('error');
    expect(loaded!.tags).toContain('data-pipeline');
    expect(loaded!.layer).toBe(Layer.Episodic);
  });

  it('preserves numeric fields accurately', () => {
    initTestStore(tmpDir);

    const entry = createMemory('test memory');
    const custom = { ...entry, retrievalCount: 7, halfLifeDays: 14, strength: 0.7654 };
    writeEntry(tmpDir, custom);

    const loaded = readEntry(tmpDir, entry.id);
    expect(loaded!.retrievalCount).toBe(7);
    expect(loaded!.halfLifeDays).toBe(14);
    expect(loaded!.strength).toBeCloseTo(0.7654, 3);
  });

  it('handles pinned flag correctly', () => {
    initTestStore(tmpDir);

    const entry = createMemory('pinned rule', { pinned: true });
    writeEntry(tmpDir, entry);

    const loaded = readEntry(tmpDir, entry.id);
    expect(loaded!.pinned).toBe(true);
  });

  it('returns null for non-existent id', () => {
    initTestStore(tmpDir);
    expect(readEntry(tmpDir, 'mem_nonexistent')).toBeNull();
  });
});

describe('deleteEntry', () => {
  it('removes the row so readEntry finds nothing', () => {
    initTestStore(tmpDir);
    const entry = createMemory('delete me');
    writeEntry(tmpDir, entry);

    deleteEntry(tmpDir, entry.id);

    expect(readEntry(tmpDir, entry.id)).toBeNull();
  });
});

describe('stats tracking', () => {
  it('writes at once after a flush, so a flushed root keeps no throttle state', () => {
    initTestStore(tmpDir);
    updateStats(tmpDir, { recalled: 1 });
    updateStats(tmpDir, { recalled: 1 });
    flushHeldMirrors(tmpDir);
    updateStats(tmpDir, { recalled: 1 });
    // SAFETY: stats.json holds the LegacyStats mirror, which always carries total_recalled.
    const file = JSON.parse(fs.readFileSync(path.join(tmpDir, 'stats.json'), 'utf8')) as { total_recalled: number };
    expect(file.total_recalled).toBe(3);
  });

  it('persists stat counters through the SQLite backbone', () => {
    initTestStore(tmpDir);
    // Longer than any rewrite, so bytes left over from it would break the mirror's JSON.
    fs.writeFileSync(path.join(tmpDir, 'stats.json'), 'x'.repeat(4096));

    updateStats(tmpDir, { remembered: 2, recalled: 1, forgotten: 1 });

    // SAFETY: reports.stats()' Record<string, unknown> return is buildStatsFromDb's fixed
    // stats-mirror shape (src/store/mirrors.ts), which always includes these counter fields.
    const stats = sqliteSyncStore(tmpDir).reports.stats() as {
      total_remembered: number;
      total_recalled: number;
      total_forgotten: number;
    };

    expect(stats.total_remembered).toBe(2);
    expect(stats.total_recalled).toBe(1);
    expect(stats.total_forgotten).toBe(1);
    flushHeldMirrors(tmpDir);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'stats.json'), 'utf8'))).toEqual(stats);
  });
});

describe('SQLite-backed search candidates', () => {
  it('returns targeted candidates for matching queries', () => {
    initTestStore(tmpDir);

    const matching = createMemory('FRED cache silently dropped TIPS during refresh', {
      tags: ['error', 'cache'],
    });
    const unrelated = createMemory('palladium futures rallied on supply shock', {
      tags: ['markets'],
    });

    writeEntry(tmpDir, matching);
    writeEntry(tmpDir, unrelated);

    const candidates = loadSearchEntries(tmpDir, 'cache refresh failure');
    expect(candidates.some((entry) => entry.id === matching.id)).toBe(true);
    expect(candidates.some((entry) => entry.id === unrelated.id)).toBe(false);
  });

  it('sleep rebuilds the FTS mirror if it goes missing', async () => {
    initTestStore(tmpDir);

    const entry = createMemory('cache refresh failure in gold pipeline', {
      tags: ['cache', 'error'],
    });
    writeEntry(tmpDir, entry);

    const db = openHippoDb(tmpDir);
    const hadFts = isFtsAvailable(db);
    if (hadFts) {
      db.exec('DELETE FROM memories_fts');
    }
    closeHippoDb(db);

    const candidates = loadSearchEntries(tmpDir, 'cache refresh');
    expect(candidates.some((candidate) => candidate.id === entry.id)).toBe(true);

    await consolidate(tmpDir);
    const reopened = openHippoDb(tmpDir);
    try {
      if (hadFts) {
        // SAFETY: the query selects a single COUNT(*) AS count aggregate, so the row
        // (if any) is shaped { count: number }.
        const row = reopened.prepare('SELECT COUNT(*) AS count FROM memories_fts WHERE id = ?').get(entry.id) as
          | { count?: number }
          | undefined;
        expect(Number(row?.count ?? 0)).toBe(1);
      }
    } finally {
      closeHippoDb(reopened);
    }
  });
});

describe('loadAllEntries', () => {
  it('returns all stored entries', () => {
    initTestStore(tmpDir);
    const entries = [createMemory('first'), createMemory('second'), createMemory('third')];
    for (const e of entries) writeEntry(tmpDir, e);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all).toHaveLength(3);
  });

  it('returns empty array for fresh store', () => {
    initTestStore(tmpDir);
    expect(loadAllEntries(tmpDir, 'default')).toHaveLength(0);
  });
});

describe('active task snapshots', () => {
  it('persists and reloads the current active snapshot', () => {
    initTestStore(tmpDir);

    const saved = saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Finish SQLite migration hardening',
      summary: 'Build, tests, and smoke pass locally.',
      next_step: 'Implement active session resume snapshot support.',
      source: 'test',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir, 'default');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(saved.id);
    expect(loaded!.task).toBe('Finish SQLite migration hardening');
    expect(loaded!.summary).toBe('Build, tests, and smoke pass locally.');
    expect(loaded!.next_step).toBe('Implement active session resume snapshot support.');
    expect(loaded!.status).toBe('active');
    expect(loaded!.session_id).toBeNull();

    const mirrorPath = path.join(tmpDir, 'buffer', 'active-task.md');
    expect(fs.existsSync(mirrorPath)).toBe(true);
    expect(fs.readFileSync(mirrorPath, 'utf8')).toContain('Implement active session resume snapshot support.');
  });

  it('persists an optional session link with the active snapshot', () => {
    initTestStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Ship session continuity',
      summary: 'Structured session events are flowing.',
      next_step: 'Surface the session trail in context output.',
      source: 'test',
      session_id: 'sess_alpha',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir, 'default');
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('sess_alpha');

    const mirrorPath = path.join(tmpDir, 'buffer', 'active-task.md');
    expect(fs.readFileSync(mirrorPath, 'utf8')).toContain('sess_alpha');
  });

  it('supersedes the previous active snapshot when a new one is saved', () => {
    initTestStore(tmpDir);

    const first = saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'First task',
      summary: 'First summary',
      next_step: 'First next step',
      source: 'test',
    });

    const second = saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Second task',
      summary: 'Second summary',
      next_step: 'Second next step',
      source: 'test',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir, 'default');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(second.id);
    expect(loaded!.task).toBe('Second task');

    const db = openHippoDb(tmpDir);
    try {
      // SAFETY: the query selects only the status column from task_snapshots, a TEXT
      // column, for a single row by primary key.
      const row = db.prepare('SELECT status FROM task_snapshots WHERE id = ?').get(first.id) as
        | { status?: string }
        | undefined;
      expect(row?.status).toBe('superseded');
    } finally {
      closeHippoDb(db);
    }
  });

  it('clears the active snapshot and removes the mirror file', () => {
    initTestStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Task to clear',
      summary: 'Some progress',
      next_step: 'Nothing else',
      source: 'test',
    });

    expect(clearActiveTaskSnapshot(tmpDir, 'default')).toBe(true);
    expect(loadActiveTaskSnapshot(tmpDir, 'default')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'buffer', 'active-task.md'))).toBe(false);
  });
});

describe('session events', () => {
  it('stores and reloads recent session events in chronological order', () => {
    initTestStore(tmpDir);

    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess_alpha',
      task: 'Ship continuity',
      event_type: 'plan',
      content: 'Decide on the first thin slice.',
      source: 'test',
      metadata: { step: 1 },
    });

    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess_alpha',
      task: 'Ship continuity',
      event_type: 'progress',
      content: 'Schema migration is done.',
      source: 'test',
      metadata: { step: 2 },
    });

    const events = listSessionEvents(tmpDir, 'default', { session_id: 'sess_alpha', limit: 5 });
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe('plan');
    expect(events[0]!.metadata).toEqual({ step: 1 });
    expect(events[1]!.event_type).toBe('progress');
    expect(events[1]!.content).toContain('Schema migration');

    const mirrorPath = path.join(tmpDir, 'buffer', 'recent-session.md');
    expect(fs.existsSync(mirrorPath)).toBe(true);
    expect(fs.readFileSync(mirrorPath, 'utf8')).toContain('sess_alpha');
  });

  it('can filter down to the newest session trail', () => {
    initTestStore(tmpDir);

    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess_old',
      task: 'Old task',
      event_type: 'note',
      content: 'Old event',
      source: 'test',
    });

    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess_new',
      task: 'New task',
      event_type: 'note',
      content: 'Newest event',
      source: 'test',
    });

    const latest = listSessionEvents(tmpDir, 'default', { limit: 1 });
    expect(latest).toHaveLength(1);
    expect(latest[0]!.session_id).toBe('sess_new');
    expect(latest[0]!.content).toBe('Newest event');
  });
});
