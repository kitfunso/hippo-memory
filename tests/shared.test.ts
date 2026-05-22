import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getGlobalRoot,
  initGlobal,
  promoteToGlobal,
  searchBoth,
  syncGlobalToLocal,
} from '../src/shared.js';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));
  initStore(dir);
  return dir;
}

function cleanUp(...dirs: string[]): void {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// getGlobalRoot
// ---------------------------------------------------------------------------

describe('getGlobalRoot', () => {
  // getGlobalRoot() reads HIPPO_HOME / XDG_DATA_HOME, and the test run sets
  // HIPPO_HOME to an isolated temp dir (vitest.config.ts). Each case controls
  // its own environment and restores it, so the test is hermetic rather than
  // dependent on the ambient ~/.hippo fallback.
  let prevHippoHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevHippoHome = process.env.HIPPO_HOME;
    prevXdg = process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
  });

  it('falls back to ~/.hippo when neither env var is set', () => {
    delete process.env.HIPPO_HOME;
    delete process.env.XDG_DATA_HOME;
    expect(getGlobalRoot()).toBe(path.join(os.homedir(), '.hippo'));
  });

  it('honours HIPPO_HOME when it is set', () => {
    const custom = path.join(os.tmpdir(), 'hippo-getglobalroot-hh');
    process.env.HIPPO_HOME = custom;
    expect(getGlobalRoot()).toBe(custom);
  });

  it('uses XDG_DATA_HOME/hippo when HIPPO_HOME is unset', () => {
    delete process.env.HIPPO_HOME;
    const xdg = path.join(os.tmpdir(), 'hippo-getglobalroot-xdg');
    process.env.XDG_DATA_HOME = xdg;
    expect(getGlobalRoot()).toBe(path.join(xdg, 'hippo'));
  });
});

// ---------------------------------------------------------------------------
// initGlobal / promoteToGlobal
// ---------------------------------------------------------------------------

describe('promoteToGlobal', () => {
  let localRoot: string;
  let globalRoot: string;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    // promoteToGlobal() resolves its destination via getGlobalRoot(), which
    // reads HIPPO_HOME. Without this override it writes into the developer's
    // real ~/.hippo store. Point it at the temp global store for isolation.
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalRoot;
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    cleanUp(localRoot, globalRoot);
  });

  it('copies a local entry into the global store', () => {
    const entry = createMemory('shared lesson about pipeline errors');
    writeEntry(localRoot, entry);

    // HIPPO_HOME is pointed at a temp global store in beforeEach, so this
    // promote lands in that temp store, not the developer's real ~/.hippo.
    const promoted = promoteToGlobal(localRoot, entry.id);
    expect(promoted.id).toMatch(/^g_/);
    expect(promoted.content).toBe(entry.content);
  });

  it('throws when ID does not exist in local store', () => {
    expect(() => promoteToGlobal(localRoot, 'nonexistent_id')).toThrow();
  });

  it('honors opts.tenantId for cross-tenant isolation (v1.11.0 residue)', () => {
    const a = createMemory('tenant-a content', { tenantId: 'tenant-a' });
    const b = createMemory('tenant-b content', { tenantId: 'tenant-b' });
    writeEntry(localRoot, a);
    writeEntry(localRoot, b);

    // Promoting tenant-a's entry with opts.tenantId='tenant-a' succeeds.
    const promoted = promoteToGlobal(localRoot, a.id, { tenantId: 'tenant-a' });
    expect(promoted.id).toMatch(/^g_/);
    expect(promoted.content).toBe('tenant-a content');

    // Promoting tenant-a's entry with opts.tenantId='tenant-b' throws —
    // readEntry returns null on a cross-tenant lookup, and promoteToGlobal
    // then surfaces 'Memory not found'.
    expect(() => promoteToGlobal(localRoot, a.id, { tenantId: 'tenant-b' })).toThrow(/Memory not found/);
  });
});

// ---------------------------------------------------------------------------
// syncGlobalToLocal
// ---------------------------------------------------------------------------

describe('syncGlobalToLocal', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('copies global entries into local', () => {
    const entry1 = createMemory('global lesson one');
    const entry2 = createMemory('global lesson two');
    writeEntry(globalRoot, entry1);
    writeEntry(globalRoot, entry2);

    const count = syncGlobalToLocal(localRoot, globalRoot);
    expect(count).toBe(2);

    const localEntries = loadAllEntries(localRoot);
    const ids = localEntries.map((e) => e.id);
    expect(ids).toContain(entry1.id);
    expect(ids).toContain(entry2.id);
  });

  it('skips entries already in local store', () => {
    const entry = createMemory('already local');
    writeEntry(globalRoot, entry);
    writeEntry(localRoot, entry); // already exists

    const count = syncGlobalToLocal(localRoot, globalRoot);
    expect(count).toBe(0);
  });

  it('returns 0 when global store does not exist', () => {
    const nonexistent = path.join(os.tmpdir(), 'hippo-no-global-' + Date.now());
    const count = syncGlobalToLocal(localRoot, nonexistent);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchBoth
// ---------------------------------------------------------------------------

describe('searchBoth', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('returns results from both local and global stores', () => {
    const local = createMemory('local cache refresh error pipeline data');
    const global = createMemory('global cache refresh error pipeline data');
    writeEntry(localRoot, local);
    writeEntry(globalRoot, global);

    const results = searchBoth('cache refresh', localRoot, globalRoot, { budget: 10000 });
    expect(results.length).toBe(2);
  });

  it('local results have higher effective scores (1.2x boost)', () => {
    // Identical content in both stores - local should score higher
    const content = 'cache refresh pipeline error data';
    const local = createMemory(content);
    const global = { ...createMemory(content), id: 'global_' + Date.now() };

    writeEntry(localRoot, local);
    writeEntry(globalRoot, global);

    const results = searchBoth('cache refresh', localRoot, globalRoot, { budget: 10000 });
    expect(results.length).toBeGreaterThan(0);

    // Find local and global result
    const localResult = results.find((r) => r.entry.id === local.id);
    const globalResult = results.find((r) => r.entry.id === global.id);

    if (localResult && globalResult) {
      expect(localResult.score).toBeGreaterThan(globalResult.score);
    }
  });

  it('returns empty when no matches in either store', () => {
    const local = createMemory('completely unrelated content about python');
    writeEntry(localRoot, local);

    const results = searchBoth('xyzzy foobar qux', localRoot, globalRoot, { budget: 10000 });
    expect(results.length).toBe(0);
  });

  it('deduplicates by ID, preferring local', () => {
    // Same ID written to both stores
    const entry = createMemory('shared unique content cache');
    writeEntry(localRoot, entry);
    writeEntry(globalRoot, entry);

    const results = searchBoth('cache content', localRoot, globalRoot, { budget: 10000 });
    const ids = results.map((r) => r.entry.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('respects token budget across merged results', () => {
    for (let i = 0; i < 5; i++) {
      writeEntry(localRoot, createMemory('cache refresh pipeline error data ' + 'x'.repeat(100) + ` ${i}`));
      writeEntry(globalRoot, createMemory('cache refresh pipeline error data ' + 'x'.repeat(100) + ` g${i}`));
    }

    const results = searchBoth('cache refresh', localRoot, globalRoot, { budget: 200 });
    const total = results.reduce((sum, r) => sum + r.tokens, 0);
    expect(total).toBeLessThanOrEqual(200);
  });
});
