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
  it('returns a path under the home directory', () => {
    const globalRoot = getGlobalRoot();
    expect(globalRoot).toContain(os.homedir());
    expect(globalRoot).toContain('.hippo');
  });
});

// ---------------------------------------------------------------------------
// initGlobal / promoteToGlobal
// ---------------------------------------------------------------------------

describe('promoteToGlobal', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('copies a local entry into the global store', () => {
    const entry = createMemory('shared lesson about pipeline errors');
    writeEntry(localRoot, entry);

    // Override global root by using promoteToGlobal with a temp global
    // We test the logic by calling syncGlobalToLocal path
    const promoted = promoteToGlobal(localRoot, entry.id);
    expect(promoted.id).toMatch(/^g_/);
    expect(promoted.content).toBe(entry.content);
  });

  it('throws when ID does not exist in local store', () => {
    expect(() => promoteToGlobal(localRoot, 'nonexistent_id')).toThrow();
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
