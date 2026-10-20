import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { serializeEntry, deserializeEntry } from '../../src/base/memory/markdown.js';
import { stampOriginProject } from '../../src/store/sqlite/entry-row.js';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries, batchWriteAndDelete } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let tmpRoot: string;

function makeProjectStore(projectName: string): string {
  const projectDir = path.join(tmpRoot, projectName);
  const storeRoot = path.join(projectDir, '.hippo');
  fs.mkdirSync(storeRoot, { recursive: true });
  initTestStore(storeRoot);
  return storeRoot;
}

beforeEach(() => {
  tmpRoot = makeRoot('origin', { init: false });
});

describe('writeEntry origin stamping (v39)', () => {
  it('stamps the store-derived project origin when the entry has none', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('remember this fact about proj a'));
    const [entry] = loadAllEntries(storeRoot, 'default');
    expect(entry.originProject).toBe('proj-a');
  });

  it('preserves an explicitly set origin', () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = { ...createMemory('a row shared from elsewhere'), originProject: 'proj-b' };
    writeEntry(storeRoot, entry);
    const [loaded] = loadAllEntries(storeRoot, 'default');
    expect(loaded.originProject).toBe('proj-b');
  });

  it("preserves an explicit '' (user-global) origin", () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = { ...createMemory('a user-global preference'), originProject: '' };
    writeEntry(storeRoot, entry);
    const [loaded] = loadAllEntries(storeRoot, 'default');
    expect(loaded.originProject).toBe('');
  });

  it('stamps origins on the batch write path too (consolidate bypasses writeEntry)', () => {
    const storeRoot = makeProjectStore('proj-a');
    batchWriteAndDelete(storeRoot, [createMemory('a consolidated semantic summary row')], []);
    const [entry] = loadAllEntries(storeRoot, 'default');
    expect(entry.originProject).toBe('proj-a');
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
    const [legacy] = loadAllEntries(storeRoot, 'default');
    expect(legacy.originProject).toBeNull();
    // Simulate the markRetrieved writeback: writeEntry on the loaded row.
    writeEntry(storeRoot, legacy);
    expect(loadAllEntries(storeRoot, 'default')[0].originProject).toBeNull();
    // The pure helper preserves null too.
    expect(stampOriginProject(storeRoot, { ...legacy, originProject: null }).originProject).toBeNull();
  });

  it('stampOriginProject never mutates the input entry', () => {
    const storeRoot = makeProjectStore('proj-a');
    const entry = createMemory('immutability check');
    const stamped = stampOriginProject(storeRoot, entry);
    expect(entry.originProject).toBeUndefined();
    expect(stamped.originProject).toBe('proj-a');
  });
});

describe('markdown mirror round-trip', () => {
  it("round-trips a project origin and the meaningful ''", () => {
    const base = createMemory('round trip content here');
    for (const origin of ['proj-a', '']) {
      const raw = serializeEntry({ ...base, originProject: origin });
      const back = deserializeEntry(raw);
      expect(back?.originProject).toBe(origin);
    }
  });

  it('round-trips an unknown (null) origin, so a rebuild never stamps it user-global', () => {
    const raw = serializeEntry({ ...createMemory('unknown-origin row content here'), originProject: null });
    expect(raw).toContain('origin_project: null');
    expect(deserializeEntry(raw)?.originProject).toBeNull();
  });

  it('omits an unstamped origin and reads a mirror with no origin field as unstamped', () => {
    const raw = serializeEntry(createMemory('unstamped row content here'));
    expect(raw).not.toContain('origin_project');
    expect(deserializeEntry(raw)?.originProject).toBeUndefined();
  });

  it('a rebuild keeps an explicit null and stamps only a mirror with no origin field', () => {
    const storeRoot = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(path.join(storeRoot, 'episodic'), { recursive: true });
    const unknown = { ...createMemory('a merged row from rows of unknown origin'), originProject: null };
    const legacy = createMemory('a markdown row from before origins existed');
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${unknown.id}.md`), serializeEntry(unknown));
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${legacy.id}.md`), serializeEntry(legacy));

    initTestStore(storeRoot);
    const byId = new Map(loadAllEntries(storeRoot, 'default').map((e) => [e.id, e.originProject]));
    expect(byId.get(unknown.id)).toBeNull();
    expect(byId.get(legacy.id)).toBe('proj-a');
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
    const [entry] = loadAllEntries(storeRoot, 'default');
    expect(entry.originProject).toBe('proj-a');
  });

  it('backfills shared:<project>: rows from their source, mapping the home basename to user-global', () => {
    const storeRoot = makeProjectStore('proj-a');
    const homeName = path.basename(os.homedir()).toLowerCase();
    writeEntry(
      storeRoot,
      createMemory('shared from proj b long ago', { source: 'shared:Proj-B:2026-01-01T00:00:00Z' }),
    );
    writeEntry(
      storeRoot,
      createMemory('shared from a home session', { source: `shared:${homeName}:2026-01-01T00:00:00Z` }),
    );
    regressStoreToV38(storeRoot);

    closeHippoDb(openHippoDb(storeRoot)); // migrate
    const entries = loadAllEntries(storeRoot, 'default');
    const fromB = entries.find((e) => e.source.startsWith('shared:Proj-B'));
    const fromHome = entries.find((e) => e.source.startsWith(`shared:${homeName}`));
    expect(fromB?.originProject).toBe('proj-b');
    expect(fromHome?.originProject).toBe('');
  });

  it('backfills promoted:<localRoot> rows with the promoting project', () => {
    const storeRoot = makeProjectStore('proj-a');
    const promotedFrom = path.join(tmpRoot, 'Proj-B', '.hippo');
    writeEntry(storeRoot, createMemory('promoted from project b long ago', { source: `promoted:${promotedFrom}` }));
    regressStoreToV38(storeRoot);

    closeHippoDb(openHippoDb(storeRoot)); // migrate
    const [entry] = loadAllEntries(storeRoot, 'default');
    expect(entry.originProject).toBe('proj-b');
  });

  it('legacy markdown bootstrap honors source evidence over the destination store origin', () => {
    // A pre-v39 markdown-only store: a shared:proj-b row imported into a
    // proj-a store must keep proj-b, not become proj-a (codex round 3 P1).
    const projectDir = path.join(tmpRoot, 'proj-a');
    const storeRoot = path.join(projectDir, '.hippo');
    fs.mkdirSync(path.join(storeRoot, 'episodic'), { recursive: true });
    // Legacy markdown has no origin field at all: leave the origin unstamped.
    const sharedRow = createMemory('markdown row shared from proj b', { source: 'shared:Proj-B:2026-01-01T00:00:00Z' });
    const plainRow = createMemory('markdown row written here long ago');
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${sharedRow.id}.md`), serializeEntry(sharedRow));
    fs.writeFileSync(path.join(storeRoot, 'episodic', `${plainRow.id}.md`), serializeEntry(plainRow));

    initTestStore(storeRoot); // bootstrapLegacyStore imports the markdown
    const entries = loadAllEntries(storeRoot, 'default');
    const shared = entries.find((e) => e.source.startsWith('shared:'));
    const plain = entries.find((e) => !e.source.startsWith('shared:'));
    expect(shared?.originProject).toBe('proj-b');
    expect(plain?.originProject).toBe('proj-a');
  });

  it('stamps min_compatible_binary 1.24.0 so pre-isolation binaries refuse the DB', () => {
    const storeRoot = makeProjectStore('proj-a');
    const db = openHippoDb(storeRoot);
    try {
      // SAFETY: query selects only the "value" text column from meta, so the
      // row (if present) has that shape; absence is handled via optional
      // chaining below.
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string };
      expect(row?.value).toBe('1.24.0');
    } finally {
      closeHippoDb(db);
    }
  });

  it('a global store nested in a git repo (HIPPO_HOME in dotfiles) still backfills user-global', () => {
    // Post-merge review P1: without the global-root special case, the walk
    // finds the surrounding repo's .git and stamps the ENTIRE global corpus
    // with that repo's name - hiding it from every project.
    const dotfiles = path.join(tmpRoot, 'dotfiles');
    fs.mkdirSync(path.join(dotfiles, '.git'), { recursive: true });
    const globalRoot = path.join(dotfiles, 'hippo-global');
    const origHippoHome = process.env.HIPPO_HOME;
    vi.stubEnv('HIPPO_HOME', globalRoot);
    try {
      initTestStore(globalRoot);
      writeEntry(globalRoot, {
        ...createMemory('a user-global lesson in a dotfiles-managed store'),
        originProject: '',
      });
      regressStoreToV38(globalRoot);
      closeHippoDb(openHippoDb(globalRoot)); // migrate
      const [entry] = loadAllEntries(globalRoot, 'default');
      expect(entry.originProject).toBe('');
    } finally {
      if (origHippoHome !== undefined) vi.stubEnv('HIPPO_HOME', origHippoHome);
      else vi.stubEnv('HIPPO_HOME', undefined);
    }
  });

  it('is idempotent: a second migration pass changes nothing', () => {
    const storeRoot = makeProjectStore('proj-a');
    writeEntry(storeRoot, createMemory('row for idempotency check'));
    regressStoreToV38(storeRoot);
    closeHippoDb(openHippoDb(storeRoot));
    const first = loadAllEntries(storeRoot, 'default').map((e) => [e.id, e.originProject]);
    closeHippoDb(openHippoDb(storeRoot));
    const second = loadAllEntries(storeRoot, 'default').map((e) => [e.id, e.originProject]);
    expect(second).toEqual(first);
  });
});
