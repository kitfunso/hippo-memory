import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, Layer } from '../src/memory.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';

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
      layer: Layer.Episodic,
    });
    writeEntry(dir, source);

    const extracted = createMemory('Alice likes coffee', {
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
