// A mirror batch lists a layer folder only when it writes into it and enough of its entries would probe it; every other
// folder is probed per file. Either way the batch leaves the same files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { layerDir, writeMarkdownMirror, writeMarkdownMirrors } from '../../src/store/sqlite/mirrors.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

const LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;

let root: string;
beforeEach(() => {
  root = makeRoot('mirror-batch');
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

/** `count` episodic entries, the first of which already has a mirror in the semantic folder from an earlier write. */
function batch(count: number): MemoryEntry[] {
  const entries = Array.from({ length: count }, (_, i) =>
    createMemory(`mirror batch row ${i}`, { layer: Layer.Episodic }),
  );
  writeMarkdownMirror(root, { ...entries[0], layer: Layer.Semantic });
  return entries;
}

/** The layer folders `fn` lists, in call order. */
function listedDuring(fn: () => void): Layer[] {
  const readdir = vi.spyOn(fs, 'readdirSync');
  syncBuiltinESMExports();
  fn();
  const byDir = new Map(LAYERS.map((layer) => [layerDir(root, layer), layer]));
  return readdir.mock.calls.flatMap(([dir]) => byDir.get(path.resolve(String(dir))) ?? []);
}

function expectMirrored(entries: readonly MemoryEntry[]): void {
  for (const entry of entries) {
    expect(fs.existsSync(path.join(layerDir(root, entry.layer), `${entry.id}.md`))).toBe(true);
  }
  expect(fs.existsSync(path.join(layerDir(root, Layer.Semantic), `${entries[0].id}.md`))).toBe(false);
}

describe('writeMarkdownMirrors', () => {
  it('lists no layer folder for a small batch, and still moves a mirror that changed layer', () => {
    const entries = batch(3);
    expect(listedDuring(() => writeMarkdownMirrors(root, entries))).toEqual([]);
    expectMirrored(entries);
  });

  it('lists no folder for a large batch in one layer, whose own files are replaced in place', () => {
    const entries = batch(64);
    expect(listedDuring(() => writeMarkdownMirrors(root, entries))).toEqual([]);
    expectMirrored(entries);
  });

  it('lists only a folder the batch writes into that 64 entries of other layers would probe', () => {
    const entries = [...batch(64), createMemory('mirror batch semantic row', { layer: Layer.Semantic })];
    expect(listedDuring(() => writeMarkdownMirrors(root, entries))).toEqual([Layer.Semantic]);
    expectMirrored(entries);
  });

  it('lists every layer folder for a stream, whose size it cannot know first', () => {
    const entries = batch(2);
    const folders = LAYERS.filter((layer) => fs.existsSync(layerDir(root, layer)));
    expect(listedDuring(() => writeMarkdownMirrors(root, entries.values()))).toEqual(folders);
    expectMirrored(entries);
  });

  it('returns the ids whose file it wrote', () => {
    const entries = batch(2);
    expect(writeMarkdownMirrors(root, entries)).toEqual(entries.map((entry) => entry.id));
  });
});
