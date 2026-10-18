// A small mirror batch probes its own files; a large one lists each layer folder once. Both leave the same files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { layerDir, writeMarkdownMirror, writeMarkdownMirrors } from '../../src/store/mirrors.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

let root: string;
beforeEach(() => {
  root = makeRoot('mirror-batch');
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

/** `count` entries, the first of which already has a mirror in another layer from an earlier write. */
function batch(count: number): MemoryEntry[] {
  const entries = Array.from({ length: count }, (_, i) =>
    createMemory(`mirror batch row ${i}`, { layer: Layer.Episodic }),
  );
  writeMarkdownMirror(root, { ...entries[0], layer: Layer.Semantic });
  return entries;
}

function listingsDuring(fn: () => void): number {
  const readdir = vi.spyOn(fs, 'readdirSync');
  syncBuiltinESMExports();
  fn();
  const layers = new Set([Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace].map((l) => layerDir(root, l)));
  return readdir.mock.calls.filter(([dir]) => layers.has(path.resolve(String(dir)))).length;
}

function expectMirrored(entries: readonly MemoryEntry[]): void {
  for (const entry of entries)
    expect(fs.existsSync(path.join(layerDir(root, entry.layer), `${entry.id}.md`))).toBe(true);
  expect(fs.existsSync(path.join(layerDir(root, Layer.Semantic), `${entries[0].id}.md`))).toBe(false);
}

describe('writeMarkdownMirrors', () => {
  it('lists no layer folder for a small batch, and still moves a mirror that changed layer', () => {
    const entries = batch(3);
    expect(listingsDuring(() => writeMarkdownMirrors(root, entries))).toBe(0);
    expectMirrored(entries);
  });

  it('lists the layer folders for a large batch, with the same files as a result', () => {
    const entries = batch(64);
    expect(listingsDuring(() => writeMarkdownMirrors(root, entries))).toBeGreaterThan(0);
    expectMirrored(entries);
  });

  it('lists the layer folders for a stream, whose size it cannot know first', () => {
    const entries = batch(2);
    expect(listingsDuring(() => writeMarkdownMirrors(root, entries.values()))).toBeGreaterThan(0);
    expectMirrored(entries);
  });
});
