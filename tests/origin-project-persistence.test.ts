import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMemory } from '../src/memory.js';
import {
  initStore,
  writeEntry,
  loadAllEntries,
  serializeEntry,
  deserializeEntry,
  stampOriginProject,
  batchWriteAndDelete,
} from '../src/store.js';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';

let tmpRoot: string;

function makeProjectStore(projectName: string): string {
  const projectDir = path.join(tmpRoot, projectName);
  const storeRoot = path.join(projectDir, '.hippo');
  fs.mkdirSync(storeRoot, { recursive: true });
  initStore(storeRoot);
  return storeRoot;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-origin-'));
  clearProjectIdentityCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeEntry origin stamping (v39)', () => {
  it('stamps the store-derived project origin when the entry has none', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('remember this fact about proj a'));
    const [entry] = loadAllEntries(storeRoot);
    expect(entry.origin_project).toBe('proj-a');
  });

  it('preserves an explicitly set origin', () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = { ...createMemory('a row shared from elsewhere'), origin_project: 'proj-b' };
    writeEntry(storeRoot, entry);
    const [loaded] = loadAllEntries(storeRoot);
    expect(loaded.origin_project).toBe('proj-b');
  });

  it("preserves an explicit '' (user-global) origin", () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = { ...createMemory('a user-global preference'), origin_project: '' };
    writeEntry(storeRoot, entry);
    const [loaded] = loadAllEntries(storeRoot);
    expect(loaded.origin_project).toBe('');
  });

  it('stamps origins on the batch write path too (consolidate bypasses writeEntry)', () => {
    const storeRoot = makeProjectStore('proj-a');
    batchWriteAndDelete(storeRoot, [createMemory('a consolidated semantic summary row')], []);
    const [entry] = loadAllEntries(storeRoot);
    expect(entry.origin_project).toBe('proj-a');
  });

  it('a legacy NULL origin is sticky across writebacks (never laundered to an injectable origin)', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('a legacy row that must stay denied'));
    const db = openHippoDb(storeRoot);
    try {
      db.exec(`UPDATE memories SET origin_project = NULL`);
    } finally {
      closeHippoDb(db);
    }
    const [legacy] = loadAllEntries(storeRoot);
    expect(legacy.origin_project).toBeNull();
    // Simulate the markRetrieved writeback: writeEntry on the loaded row.
    writeEntry(storeRoot, legacy);
    expect(loadAllEntries(storeRoot)[0].origin_project).toBeNull();
    // The pure helper preserves null too.
    expect(stampOriginProject(storeRoot, { ...legacy, origin_project: null }).origin_project).toBeNull();
  });

  it('stampOriginProject never mutates the input entry', () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = createMemory('immutability check');
    const stamped = stampOriginProject(storeRoot, entry);
    expect(entry.origin_project).toBeUndefined();
    expect(stamped.origin_project).toBe('proj-a');
  });
});

describe('markdown mirror round-trip', () => {
  it("round-trips a project origin and the meaningful ''", () => {
    const base = createMemory('round trip content here');
    for (const origin of ['proj-a', '']) {
      const raw = serializeEntry({ ...base, origin_project: origin });
      const back = deserializeEntry(raw);
      expect(back?.origin_project).toBe(origin);
    }
  });

  it('omits legacy null/undefined origin and deserializes it back to null', () => {
    const base = createMemory('legacy row content here');
    const raw = serializeEntry({ ...base, origin_project: null });
    expect(raw).not.toContain('origin_project');
    expect(deserializeEntry(raw)?.origin_project).toBeNull();
  });
});

describe('v39 migration backfill', () => {
  function regressStoreToV38(storeRoot: string): void {
    const db = openHippoDb(storeRoot);
    try {
      db.exec(`UPDATE memories SET origin_project = NULL`);
      db.prepare(`UPDATE meta SET value = '38' WHERE key = 'schema_version'`).run();
    } finally {
      closeHippoDb(db);
    }
  }

  it('backfills project-store rows with the store-derived origin', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('an old row written before v39'));
    regressStoreToV38(storeRoot);

    const db = openHippoDb(storeRoot); // reopening runs the v39 migration
    try {
      expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(39);
    } finally {
      closeHippoDb(db);
    }
    const [entry] = loadAllEntries(storeRoot);
    expect(entry.origin_project).toBe('proj-a');
  });

  it('backfills shared:<project>: rows from their source, mapping the home basename to user-global', () => {
    const storeRoot = makeProjectStore('proj-a');
    const homeName = path.basename(os.homedir()).toLowerCase();
    writeEntry(storeRoot, createMemory('shared from proj b long ago', { source: 'shared:Proj-B:2026-01-01T00:00:00Z' }));
    writeEntry(storeRoot, createMemory('shared from a home session', { source: `shared:${homeName}:2026-01-01T00:00:00Z` }));
    regressStoreToV38(storeRoot);

    closeHippoDb(openHippoDb(storeRoot)); // migrate
    const entries = loadAllEntries(storeRoot);
    const fromB = entries.find((e) => e.source.startsWith('shared:Proj-B'));
    const fromHome = entries.find((e) => e.source.startsWith(`shared:${homeName}`));
    expect(fromB?.origin_project).toBe('proj-b');
    expect(fromHome?.origin_project).toBe('');
  });

  it('backfills promoted:<localRoot> rows with the promoting project', () => {
    const storeRoot = makeProjectStore('proj-a');
    const promotedFrom = path.join(tmpRoot, 'Proj-B', '.hippo');
    writeEntry(storeRoot, createMemory('promoted from project b long ago', { source: `promoted:${promotedFrom}` }));
    regressStoreToV38(storeRoot);

    closeHippoDb(openHippoDb(storeRoot)); // migrate
    const [entry] = loadAllEntries(storeRoot);
    expect(entry.origin_project).toBe('proj-b');
  });

  it('legacy markdown bootstrap honors source evidence over the destination store origin', () => {
    // A pre-v39 markdown-only store: a shared:proj-b row imported into a
    // proj-a store must keep proj-b, not become proj-a (codex round 3 P1).
    const projectDir = path.join(tmpRoot, 'proj-a');
    const storeRoot = path.join(projectDir, '.hippo');
    fs.mkdirSync(path.join(storeRoot, 'episodic'), { recursive: true });
    const sharedRow = { ...createMemory('markdown row shared from proj b', { source: 'shared:Proj-B:2026-01-01T00:00:00Z' }), origin_project: null };
    const plainRow = { ...createMemory('markdown row written here long ago'), origin_project: null };
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${sharedRow.id}.md`), serializeEntry(sharedRow));
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${plainRow.id}.md`), serializeEntry(plainRow));

    initStore(storeRoot); // bootstrapLegacyStore imports the markdown
    const entries = loadAllEntries(storeRoot);
    const shared = entries.find((e) => e.source.startsWith('shared:'));
    const plain = entries.find((e) => !e.source.startsWith('shared:'));
    expect(shared?.origin_project).toBe('proj-b');
    expect(plain?.origin_project).toBe('proj-a');
  });

  it('stamps min_compatible_binary 1.24.0 so pre-isolation binaries refuse the DB', () => {
    const storeRoot = makeProjectStore('proj-a');
    const db = openHippoDb(storeRoot);
    try {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string };
      expect(row?.value).toBe('1.24.0');
    } finally {
      closeHippoDb(db);
    }
  });

  it('is idempotent: a second migration pass changes nothing', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('row for idempotency check'));
    regressStoreToV38(storeRoot);
    closeHippoDb(openHippoDb(storeRoot));
    const first = loadAllEntries(storeRoot).map((e) => [e.id, e.origin_project]);
    closeHippoDb(openHippoDb(storeRoot));
    const second = loadAllEntries(storeRoot).map((e) => [e.id, e.origin_project]);
    expect(second).toEqual(first);
  });
});
