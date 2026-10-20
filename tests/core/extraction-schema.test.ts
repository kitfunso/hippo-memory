import { describe, it, expect } from 'vitest';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

let tmpDir: string;

function setup(): string {
  tmpDir = makeRoot('extract-schema');
  return tmpDir;
}

describe('extracted_from field', () => {
  it('defaults to null when not specified', () => {
    const dir = setup();
    const entry = createMemory('Test memory without extraction link', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    expect(entry.extractedFrom).toBeNull();

    writeEntry(dir, entry);
    const loaded = readEntry(dir, entry.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.extractedFrom).toBeNull();
  });

  it('persists through write/read cycle', () => {
    const dir = setup();
    const source = createMemory('Source conversation memory', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(dir, source);

    const extracted = createMemory('Alice likes coffee', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      extractedFrom: source.id,
    });
    expect(extracted.extractedFrom).toBe(source.id);

    writeEntry(dir, extracted);
    const loaded = readEntry(dir, extracted.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.extractedFrom).toBe(source.id);
  });
});
