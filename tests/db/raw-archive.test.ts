import { afterEach, describe, it, expect, vi } from 'vitest';
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { log } from '../../src/base/util/log.js';
import { openHippoDb, openHippoDbReadOnly, closeHippoDb } from '../../src/db/index.js';
import { archiveRawMemories, archiveRawMemory, markMirrorCleaned } from '../../src/store/sqlite/entries/raw-archive.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { listMemoryConflicts, replaceDetectedConflicts, writeEntry } from '../_helpers/root-forms.js';
import { sqliteStore } from '../_helpers/test-session.js';

interface ArchivedRawPayload {
  redacted?: boolean;
  tenant_id?: string;
  kind?: string;
  reason?: string;
  archived_at?: string;
  id?: string;
  content?: string;
}

const insertRaw = (db: ReturnType<typeof openHippoDb>, id: string, kind = 'raw'): void => {
  db.prepare(
    `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES (?,'2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed',?,?)`,
  ).run(id, `raw text of ${id}`, kind);
};
const count = (db: ReturnType<typeof openHippoDb>, sql: string): number =>
  // SAFETY: COUNT(*) answers one row.
  (db.prepare(sql).get() as { n: number }).n;

describe('archiveRawMemory', () => {
  it('snapshots row into raw_archive then removes it from memories', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('r1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','sensitive content','raw')`,
    ).run();
    archiveRawMemory(db, 'r1', { reason: 'GDPR right-to-be-forgotten', who: 'user:42' });
    const remaining = db.prepare(`SELECT id FROM memories WHERE id='r1'`).get();
    expect(remaining).toBeUndefined();
    // SAFETY: literal SELECT of the raw_archive row this test just wrote via
    // archiveRawMemory above; all four columns are NOT NULL in the schema.
    const archived = db
      .prepare(`SELECT memory_id, reason, archived_by, payload_json FROM raw_archive WHERE memory_id='r1'`)
      .get() as { memory_id: string; reason: string; archived_by: string; payload_json: string };
    expect(archived.memory_id).toBe('r1');
    expect(archived.reason).toBe('GDPR right-to-be-forgotten');
    expect(archived.archived_by).toBe('user:42');
    // v0.39 Path A: payload_json is metadata-only — original content is NOT
    // stored. The audit_log row carries the compliance trail; raw_archive
    // tracks only that an archive happened, for what tenant/kind, and why.
    // SAFETY: payload_json is written by archiveRawMemory (src/store/raw-archive.ts)
    // with exactly this metadata-only shape.
    const payload = JSON.parse(archived.payload_json) as ArchivedRawPayload;
    expect(payload.redacted).toBe(true);
    expect(payload.tenant_id).toBe('default');
    expect(payload.kind).toBe('raw');
    expect(payload.reason).toBe('GDPR right-to-be-forgotten');
    expect(payload.archived_at).toEqual(expect.any(String));
    expect(payload.id).toBeUndefined();
    expect(payload.content).toBeUndefined();
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to archive non-raw memories', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('d1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
    ).run();
    expect(() => archiveRawMemory(db, 'd1', { reason: 'test', who: 'user:1' })).toThrow(/not raw/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('throws when memory id does not exist', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    expect(() => archiveRawMemory(db, 'missing', { reason: 'test', who: 'user:1' })).toThrow(/not found/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('purges memories_fts row so archived content is not searchable (GDPR)', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    // Skip if FTS5 not available in this build
    // SAFETY: literal SELECT of a single known meta key; the value column is
    // NOT NULL in the schema when the row exists.
    const ftsRow = db.prepare(`SELECT value FROM meta WHERE key='fts5_available'`).get() as
      | { value: string }
      | undefined;
    if (!ftsRow || ftsRow.value !== '1') {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
      return;
    }
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('rfts','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','classifiedsecret unique-canary-zylph','raw')`,
    ).run();
    db.prepare(`INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)`).run(
      'rfts',
      'classifiedsecret unique-canary-zylph',
      '[]',
    );
    // Pre-condition: FTS finds it
    const before = db.prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ?`).all('zylph');
    expect(before.length).toBe(1);
    archiveRawMemory(db, 'rfts', { reason: 'GDPR delete', who: 'user:99' });
    // Post-condition: FTS no longer finds it
    const after = db.prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ?`).all('zylph');
    expect(after.length).toBe(0);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('a failed full-text purge fails the archive and rolls all of it back', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    try {
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('rfail','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','purge must not half-happen','raw')`,
      ).run();
      // fts5_available stays '1', so the archive still tries the purge and it fails.
      db.prepare(
        `INSERT INTO meta(key, value) VALUES ('fts5_available', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`,
      ).run();
      db.exec('DROP TABLE memories_fts');

      expect(() => archiveRawMemory(db, 'rfail', { reason: 'GDPR delete', who: 'user:7' })).toThrow(/memories_fts/);

      expect(db.prepare(`SELECT id FROM memories WHERE id = 'rfail'`).get()).toEqual({ id: 'rfail' });
      expect(db.prepare(`SELECT memory_id FROM raw_archive WHERE memory_id = 'rfail'`).get()).toBeUndefined();
      expect(
        db.prepare(`SELECT 1 AS x FROM audit_log WHERE op = 'archive_raw' AND target_id = 'rfail'`).get(),
      ).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('archiveRawMemories', () => {
  it('archives one row or many in as many statements, each with its own archive and audit row', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    try {
      for (const id of ['one', 'm1', 'm2', 'm3', 'm4', 'm5']) insertRaw(db, id);
      const opts = { reason: 'artifact deleted', who: 'github:bot' };
      const single = recordStatements(() => archiveRawMemories(db, ['one'], opts)).statements;
      const many = recordStatements(() => archiveRawMemories(db, ['m1', 'm2', 'm3', 'm4', 'm5'], opts)).statements;
      expect(many).toHaveLength(single.length);
      expect(count(db, `SELECT COUNT(*) AS n FROM memories`)).toBe(0);
      expect(count(db, `SELECT COUNT(*) AS n FROM raw_archive WHERE archived_by = 'github:bot'`)).toBe(6);
      expect(count(db, `SELECT COUNT(*) AS n FROM audit_log WHERE op = 'archive_raw'`)).toBe(6);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('archives none when any row is missing or not raw', () => {
    const home = makeRoot('arch');
    const db = openHippoDb(home);
    try {
      insertRaw(db, 'r1');
      insertRaw(db, 'd1', 'distilled');
      const opts = { reason: 'test', who: 'user:1' };
      expect(() => archiveRawMemories(db, ['r1', 'gone'], opts)).toThrow(/memory not found: gone/);
      expect(() => archiveRawMemories(db, ['r1', 'd1'], opts)).toThrow(/memory d1 is not raw/);
      expect(count(db, `SELECT COUNT(*) AS n FROM memories`)).toBe(2);
      expect(count(db, `SELECT COUNT(*) AS n FROM raw_archive`)).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

type Db = ReturnType<typeof openHippoDb>;

const STAMP = '2026-11-10T09:30:00.123Z';
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BUSY_KEY = 'archive-mirror-stamp-busy';

function stampOf(db: Db, id: string): string | null {
  // SAFETY: the one selected column is mirror_cleaned_at, NULL until a stamp lands; each id asked for was archived first.
  const row = db.prepare(`SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`).get(id) as {
    mirror_cleaned_at: string | null;
  };
  return row.mirror_cleaned_at;
}

/** The stamp in the store at `home`, read without the open-time reaper that would set it. */
function storedStamp(home: string, id: string): string | null {
  const db = openHippoDbReadOnly(home);
  try {
    return stampOf(db, id);
  } finally {
    closeHippoDb(db);
  }
}

/** A store with the `ids` archived and unstamped, and a second connection to take its write lock. */
function withArchivedRows(ids: readonly string[], run: (db: Db, holder: Db) => void): void {
  const home = makeRoot('arch');
  const db = openHippoDb(home, { busyWaitMs: 50 });
  const holder = openHippoDb(home);
  try {
    for (const id of ids) {
      insertRaw(db, id);
      archiveRawMemory(db, id, { reason: 'test', who: 'user:1' });
    }
    run(db, holder);
  } finally {
    if (holder.isTransaction) holder.exec('ROLLBACK');
    closeHippoDb(holder);
    closeHippoDb(db);
  }
}

describe('markMirrorCleaned', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the row for the reaper instead of throwing while another connection holds the write lock', () => {
    const warned = vi.spyOn(log, 'warnThenDebug').mockImplementation(() => {});
    withArchivedRows(['r1'], (db, holder) => {
      holder.exec('BEGIN IMMEDIATE');
      expect(() => markMirrorCleaned(db, 'r1', STAMP)).not.toThrow();
      expect(stampOf(db, 'r1')).toBeNull();
      expect(warned.mock.calls.map(([key]) => key)).toEqual([BUSY_KEY]);

      holder.exec('ROLLBACK');
      markMirrorCleaned(db, 'r1', STAMP);
      expect(stampOf(db, 'r1')).toBe(STAMP);
    });
  });

  it('a busy stamp on one id does not skip the ids after it', () => {
    vi.spyOn(log, 'warnThenDebug').mockImplementation(() => {});
    withArchivedRows(['a', 'b'], (db, holder) => {
      holder.exec('BEGIN IMMEDIATE');
      for (const id of ['a', 'b']) {
        markMirrorCleaned(db, id, STAMP);
        if (holder.isTransaction) holder.exec('ROLLBACK');
      }
      expect(stampOf(db, 'a')).toBeNull();
      expect(stampOf(db, 'b')).toBe(STAMP);
    });
  });

  it('rethrows an error that is not a busy store', () => {
    withArchivedRows(['r1'], (db) => {
      db.exec('DROP TABLE raw_archive');
      expect(() => markMirrorCleaned(db, 'r1', STAMP)).toThrow(/raw_archive/);
    });
  });
});

interface RawLoserConflict {
  readonly conflictId: number;
  readonly keeper: MemoryEntry;
  readonly loser: MemoryEntry;
}

/** A kept memory and a raw one, each with its markdown mirror, and the open conflict between them. */
async function conflictOverRawLoser(home: string): Promise<RawLoserConflict> {
  const keeper = createMemory('keeper content for the mirror stamp tests', { tags: ['x'] });
  const loser = createMemory('raw loser content for the mirror stamp tests', { tags: ['x'], kind: 'raw' });
  writeEntry(home, keeper);
  writeEntry(home, loser);
  replaceDetectedConflicts(home, [
    { memoryAId: keeper.id, memoryBId: loser.id, reason: 'mirror stamp test', score: 0.9 },
  ]);
  const [conflict] = await listMemoryConflicts(home);
  return { conflictId: conflict!.id, keeper, loser };
}

type Store = ReturnType<typeof sqliteStore>;

function forgetLoser(store: Store, { conflictId, keeper, loser }: RawLoserConflict): Promise<boolean> {
  return store.conflicts.resolve('default', {
    conflictId,
    keep: { id: keeper.id, scope: null },
    loser: { id: loser.id, scope: null },
    fate: { kind: 'remove' },
    actor: 'cli',
    reason: 'mirror stamp test',
    at: new Date().toISOString(),
  });
}

const rejectById = (store: Store, memoryId: string) =>
  store.rejections.apply({ tenantId: 'default', actor: 'cli', reason: 'mirror stamp test', memoryId, ownScope: null });

const mirrorsOf = (home: string, id: string): string[] =>
  fs
    .readdirSync(home, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(`${id}.md`));

/** Wraps the real unlink so `holder` takes the write lock once the first mirror of `ids` is gone, which is after the
 * remove committed, and lets it go before the second one goes. Returns the ids as they are unlinked. */
function lockAfterFirstMirrorUnlink(holder: Db, ids: readonly string[]): string[] {
  const realUnlink = fs.unlinkSync;
  const unlinked: string[] = [];
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    const id = ids.find((candidate) => path.basename(String(file)) === `${candidate}.md`);
    if (id !== undefined && holder.isTransaction) holder.exec('ROLLBACK');
    realUnlink(file);
    if (id === undefined) return;
    unlinked.push(id);
    if (unlinked.length === 1) holder.exec('BEGIN IMMEDIATE');
  });
  syncBuiltinESMExports();
  return unlinked;
}

describe('the mirror stamp of a raw row a command removes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('is an ISO-8601 UTC millisecond time after resolve --forget', async () => {
    const home = makeRoot('arch');
    const seed = await conflictOverRawLoser(home);
    expect(await forgetLoser(sqliteStore(home), seed)).toBe(true);
    expect(storedStamp(home, seed.loser.id)).toMatch(ISO_MS_UTC);
  });

  it('is an ISO-8601 UTC millisecond time after reject', async () => {
    const home = makeRoot('arch');
    const loser = createMemory('raw text to reject for the mirror stamp tests', { kind: 'raw' });
    writeEntry(home, loser);
    await rejectById(sqliteStore(home), loser.id);
    expect(storedStamp(home, loser.id)).toMatch(ISO_MS_UTC);
  });

  it('is an ISO-8601 UTC millisecond time after archiveRaw', async () => {
    const home = makeRoot('arch');
    const raw = createMemory('raw text to archive for the mirror stamp tests', { kind: 'raw' });
    writeEntry(home, raw);
    await sqliteStore(home).entryWrites.archiveRaw({
      id: raw.id,
      tenantId: 'default',
      actor: 'cli',
      role: 'admin',
      ownScope: null,
      reason: 'mirror stamp test',
    });
    expect(storedStamp(home, raw.id)).toMatch(ISO_MS_UTC);
  });

  it('resolve --forget returns when the store turns busy at the stamp, and the next open stamps it', async () => {
    vi.spyOn(log, 'warnThenDebug').mockImplementation(() => {});
    const home = makeRoot('arch');
    const seed = await conflictOverRawLoser(home);
    const holder = openHippoDb(home, { busyWaitMs: 50 });
    try {
      lockAfterFirstMirrorUnlink(holder, [seed.loser.id]);
      expect(await forgetLoser(sqliteStore(home, { busyWaitMs: 100 }), seed)).toBe(true);
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    expect(mirrorsOf(home, seed.loser.id)).toEqual([]);
    expect(storedStamp(home, seed.loser.id)).toBeNull();

    closeHippoDb(openHippoDb(home));
    expect(storedStamp(home, seed.loser.id)).toMatch(ISO_MS_UTC);
  });

  it('reject stamps the second duplicate after the first was busy, and the next open stamps the first', async () => {
    vi.spyOn(log, 'warnThenDebug').mockImplementation(() => {});
    const home = makeRoot('arch');
    const a = createMemory('duplicate raw text for the mirror stamp tests', { kind: 'raw' });
    const b = createMemory('DUPLICATE RAW TEXT FOR THE MIRROR STAMP TESTS', { kind: 'raw' });
    writeEntry(home, a);
    writeEntry(home, b);
    const holder = openHippoDb(home, { busyWaitMs: 50 });
    let unlinked: string[];
    try {
      unlinked = lockAfterFirstMirrorUnlink(holder, [a.id, b.id]);
      const applied = await rejectById(sqliteStore(home, { busyWaitMs: 100 }), a.id);
      expect([...applied.removedRawIds].sort()).toEqual([a.id, b.id].sort());
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    const [first, second] = unlinked;
    expect(storedStamp(home, first!)).toBeNull();
    expect(storedStamp(home, second!)).toMatch(ISO_MS_UTC);

    closeHippoDb(openHippoDb(home));
    expect(storedStamp(home, first!)).toMatch(ISO_MS_UTC);
  });
});
