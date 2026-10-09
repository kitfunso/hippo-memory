// `hippo status` counts stored vectors from ids and one blob length; it must never decode a vector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { saveStoredVectors, storedVectorSummary } from '../src/store/vector-index.js';
import { handleStatus } from '../src/cli/status.js';

type Walk = (this: Float32Array) => IterableIterator<number>;
const HIPPO_BIN = path.join(process.cwd(), 'bin', 'hippo.js');
let home: string;
let root: string;

function liveIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const entry = createMemory(`status vector memory ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    return entry.id;
  });
}

function status(): string[] {
  const env = { ...process.env, HIPPO_HOME: path.join(home, 'global'), HOME: home, USERPROFILE: home };
  return execFileSync('node', [HIPPO_BIN, 'status'], { cwd: home, env, encoding: 'utf-8' }).split(/\r?\n/);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-status-vec-'));
  root = path.join(home, '.hippo');
  initStore(root);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('storedVectorSummary', () => {
  it('returns every vector id, orphans included, and the dimension', () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]], ['orphan', [0, 1, 0, 1]]], 'm');
    const summary = storedVectorSummary(root);
    expect([...summary.ids].sort()).toEqual([a, b, 'orphan'].sort());
    expect(summary.dims).toBe(4);
  });

  it('returns an empty set and no dimension on a store without vectors', () => {
    expect(storedVectorSummary(root)).toEqual({ ids: new Set(), dims: undefined });
  });
});

describe('hippo status embedding lines', () => {
  it('prints the same embedded count, dimension and orphan note as before', () => {
    const [a, b] = liveIds(3);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]], ['orphan', [0, 1, 0, 1]]], 'm');
    const lines = status().filter((l) => l.startsWith('Embedded:') || l.includes('model changed'));
    expect(lines).toEqual([
      'Embedded:          2/3 memories (4-dim) (1 orphaned, run `hippo embed` to prune)',
      '                   model changed, run `hippo embed` to reindex',
    ]);
  });

  it('reads no vector element while counting them', () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]]], 'm');
    // Array.from over a decoded Float32Array walks this iterator once per vector, so a decode shows as a call.
    // SAFETY: %TypedArray%.prototype always carries Symbol.iterator, whose receiver is a typed array.
    const proto = Object.getPrototypeOf(Float32Array.prototype) as { [Symbol.iterator]: Walk };
    const original = proto[Symbol.iterator];
    let walks = 0;
    proto[Symbol.iterator] = function (this: Float32Array) { walks++; return original.call(this); };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      handleStatus({ hippoRoot: root, args: [], flags: {} });
    } finally {
      proto[Symbol.iterator] = original;
      log.mockRestore();
    }
    expect(walks).toBe(0);
  });
});
