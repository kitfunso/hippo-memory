import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import {
  initStore,
  writeEntry,
  readEntry,
  deleteEntry,
  loadAllEntries,
  loadSearchEntries,
  loadIndex,
  rebuildIndex,
  loadStats,
  updateStats,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
} from '../src/store.js';
import {
  openHippoDb,
  closeHippoDb,
  isFtsAvailable,
  getSchemaVersion,
  getCurrentSchemaVersion,
} from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyFixtureRoot = path.join(__dirname, 'fixtures', 'legacy-markdown-store');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('store initialization', () => {
  it('creates a SQLite database backbone for new stores', () => {
    initStore(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'hippo.db'))).toBe(true);
  });

  it('imports the explicit legacy markdown fixture into SQLite on first init', () => {
    fs.cpSync(legacyFixtureRoot, tmpDir, { recursive: true });

    initStore(tmpDir);

    const alpha = readEntry(tmpDir, 'mem_legacy_alpha');
    const beta = readEntry(tmpDir, 'mem_legacy_beta');

    expect(alpha).not.toBeNull();
    expect(alpha!.content).toContain('Legacy markdown alpha memory');
    expect(alpha!.tags).toEqual(['legacy', 'block-list', 'migration']);
    expect(alpha!.conflicts_with).toEqual(['mem_legacy_beta']);

    expect(beta).not.toBeNull();
    expect(beta!.tags).toEqual(['legacy', 'semantic', 'fixture']);
    expect(beta!.conflicts_with).toEqual(['mem_legacy_alpha']);
    expect(beta!.pinned).toBe(true);

    const index = loadIndex(tmpDir);
    expect(index.last_retrieval_ids).toEqual(['mem_legacy_alpha', 'mem_legacy_beta']);
    expect(index.entries['mem_legacy_alpha']).toBeDefined();
    expect(index.entries['mem_legacy_beta']).toBeDefined();

    const stats = loadStats(tmpDir) as {
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

    expect(loadAllEntries(tmpDir).map((entry) => entry.id).sort()).toEqual([
      'mem_legacy_alpha',
      'mem_legacy_beta',
    ]);
  });

  it('fails safe on a corrupt SQLite file and preserves legacy markdown source', () => {
    fs.cpSync(legacyFixtureRoot, tmpDir, { recursive: true });

    const legacyPath = path.join(tmpDir, 'episodic', 'mem_legacy_alpha.md');
    const originalRaw = fs.readFileSync(legacyPath, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'hippo.db'), 'definitely not sqlite', 'utf8');

    expect(() => initStore(tmpDir)).toThrow();
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(originalRaw);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('tracks schema version through the migration scaffold', () => {
    initStore(tmpDir);

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
    initStore(tmpDir);

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
    initStore(tmpDir);

    const entry = createMemory('test memory');
    const custom = { ...entry, retrieval_count: 7, half_life_days: 14, strength: 0.7654 };
    writeEntry(tmpDir, custom);

    const loaded = readEntry(tmpDir, entry.id);
    expect(loaded!.retrieval_count).toBe(7);
    expect(loaded!.half_life_days).toBe(14);
    expect(loaded!.strength).toBeCloseTo(0.7654, 3);
  });

  it('handles pinned flag correctly', () => {
    initStore(tmpDir);

    const entry = createMemory('pinned rule', { pinned: true });
    writeEntry(tmpDir, entry);

    const loaded = readEntry(tmpDir, entry.id);
    expect(loaded!.pinned).toBe(true);
  });

  it('returns null for non-existent id', () => {
    initStore(tmpDir);
    expect(readEntry(tmpDir, 'mem_nonexistent')).toBeNull();
  });
});

describe('index management', () => {
  it('updates index on write', () => {
    initStore(tmpDir);
    const entry = createMemory('index test');
    writeEntry(tmpDir, entry);

    const index = loadIndex(tmpDir);
    expect(index.entries[entry.id]).toBeDefined();
    expect(index.entries[entry.id].id).toBe(entry.id);
  });

  it('removes from index on delete', () => {
    initStore(tmpDir);
    const entry = createMemory('delete me');
    writeEntry(tmpDir, entry);

    deleteEntry(tmpDir, entry.id);

    const index = loadIndex(tmpDir);
    expect(index.entries[entry.id]).toBeUndefined();
  });

  it('rebuild restores index from disk', () => {
    initStore(tmpDir);

    const e1 = createMemory('memory one');
    const e2 = createMemory('memory two');
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    const indexPath = path.join(tmpDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: {}, last_retrieval_ids: [] }));

    rebuildIndex(tmpDir);

    const index = loadIndex(tmpDir);
    expect(Object.keys(index.entries)).toHaveLength(2);
    expect(index.entries[e1.id]).toBeDefined();
    expect(index.entries[e2.id]).toBeDefined();
  });
});

describe('stats tracking', () => {
  it('persists stat counters through the SQLite backbone', () => {
    initStore(tmpDir);

    updateStats(tmpDir, { remembered: 2, recalled: 1, forgotten: 1 });

    const stats = loadStats(tmpDir) as {
      total_remembered: number;
      total_recalled: number;
      total_forgotten: number;
    };

    expect(stats.total_remembered).toBe(2);
    expect(stats.total_recalled).toBe(1);
    expect(stats.total_forgotten).toBe(1);
  });
});

describe('SQLite-backed search candidates', () => {
  it('returns targeted candidates for matching queries', () => {
    initStore(tmpDir);

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

  it('rebuilds the FTS mirror if it goes missing', () => {
    initStore(tmpDir);

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

    const reopened = openHippoDb(tmpDir);
    try {
      if (hadFts) {
        const row = reopened.prepare('SELECT COUNT(*) AS count FROM memories_fts WHERE id = ?').get(entry.id) as { count?: number } | undefined;
        expect(Number(row?.count ?? 0)).toBe(1);
      }
    } finally {
      closeHippoDb(reopened);
    }
  });
});

describe('loadAllEntries', () => {
  it('returns all stored entries', () => {
    initStore(tmpDir);
    const entries = [
      createMemory('first'),
      createMemory('second'),
      createMemory('third'),
    ];
    for (const e of entries) writeEntry(tmpDir, e);

    const all = loadAllEntries(tmpDir);
    expect(all).toHaveLength(3);
  });

  it('returns empty array for fresh store', () => {
    initStore(tmpDir);
    expect(loadAllEntries(tmpDir)).toHaveLength(0);
  });
});

describe('active task snapshots', () => {
  it('persists and reloads the current active snapshot', () => {
    initStore(tmpDir);

    const saved = saveActiveTaskSnapshot(tmpDir, {
      task: 'Finish SQLite migration hardening',
      summary: 'Build, tests, and smoke pass locally.',
      next_step: 'Implement active session resume snapshot support.',
      source: 'test',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir);
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
    initStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, {
      task: 'Ship session continuity',
      summary: 'Structured session events are flowing.',
      next_step: 'Surface the session trail in context output.',
      source: 'test',
      session_id: 'sess_alpha',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('sess_alpha');

    const mirrorPath = path.join(tmpDir, 'buffer', 'active-task.md');
    expect(fs.readFileSync(mirrorPath, 'utf8')).toContain('sess_alpha');
  });

  it('supersedes the previous active snapshot when a new one is saved', () => {
    initStore(tmpDir);

    const first = saveActiveTaskSnapshot(tmpDir, {
      task: 'First task',
      summary: 'First summary',
      next_step: 'First next step',
      source: 'test',
    });

    const second = saveActiveTaskSnapshot(tmpDir, {
      task: 'Second task',
      summary: 'Second summary',
      next_step: 'Second next step',
      source: 'test',
    });

    const loaded = loadActiveTaskSnapshot(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(second.id);
    expect(loaded!.task).toBe('Second task');

    const db = openHippoDb(tmpDir);
    try {
      const row = db.prepare('SELECT status FROM task_snapshots WHERE id = ?').get(first.id) as { status?: string } | undefined;
      expect(row?.status).toBe('superseded');
    } finally {
      closeHippoDb(db);
    }
  });

  it('clears the active snapshot and removes the mirror file', () => {
    initStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, {
      task: 'Task to clear',
      summary: 'Some progress',
      next_step: 'Nothing else',
      source: 'test',
    });

    expect(clearActiveTaskSnapshot(tmpDir)).toBe(true);
    expect(loadActiveTaskSnapshot(tmpDir)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'buffer', 'active-task.md'))).toBe(false);
  });
});

describe('session events', () => {
  it('stores and reloads recent session events in chronological order', () => {
    initStore(tmpDir);

    appendSessionEvent(tmpDir, {
      session_id: 'sess_alpha',
      task: 'Ship continuity',
      event_type: 'plan',
      content: 'Decide on the first thin slice.',
      source: 'test',
      metadata: { step: 1 },
    });

    appendSessionEvent(tmpDir, {
      session_id: 'sess_alpha',
      task: 'Ship continuity',
      event_type: 'progress',
      content: 'Schema migration is done.',
      source: 'test',
      metadata: { step: 2 },
    });

    const events = listSessionEvents(tmpDir, { session_id: 'sess_alpha', limit: 5 });
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
    initStore(tmpDir);

    appendSessionEvent(tmpDir, {
      session_id: 'sess_old',
      task: 'Old task',
      event_type: 'note',
      content: 'Old event',
      source: 'test',
    });

    appendSessionEvent(tmpDir, {
      session_id: 'sess_new',
      task: 'New task',
      event_type: 'note',
      content: 'Newest event',
      source: 'test',
    });

    const latest = listSessionEvents(tmpDir, { limit: 1 });
    expect(latest).toHaveLength(1);
    expect(latest[0]!.session_id).toBe('sess_new');
    expect(latest[0]!.content).toBe('Newest event');
  });
});
