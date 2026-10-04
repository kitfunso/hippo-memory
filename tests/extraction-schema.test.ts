import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-extract-schema-'));
  initStore(tmpDir);
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extracted_from field', () => {
  it('defaults to null when not specified', () => {
    const dir = setup();
    const entry = createMemory('Test memory without extraction link', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    expect(entry.extracted_from).toBeNull();

    writeEntry(dir, entry);
    const loaded = readEntry(dir, entry.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.extracted_from).toBeNull();
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
      extracted_from: source.id,
    });
    expect(extracted.extracted_from).toBe(source.id);

    writeEntry(dir, extracted);
    const loaded = readEntry(dir, extracted.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.extracted_from).toBe(source.id);
  });
});
