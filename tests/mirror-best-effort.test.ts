import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, readEntry, deleteEntry, batchWriteAndDelete } from '../src/store.js';
import { createMemory } from '../src/memory.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mirror-'));
  initStore(root);
  // A directory where index.json belongs makes every index mirror write fail after the COMMIT.
  fs.rmSync(path.join(root, 'index.json'), { force: true });
  fs.mkdirSync(path.join(root, 'index.json'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mirror write failures after COMMIT', () => {
  it('writeEntry keeps the committed row and warns instead of throwing', () => {
    const entry = createMemory('mirror failure keeps the row');
    expect(() => writeEntry(root, entry)).not.toThrow();
    expect(readEntry(root, entry.id)?.content).toBe('mirror failure keeps the row');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('index.json not refreshed'));
  });

  it('batchWriteAndDelete and deleteEntry report their committed changes as done', () => {
    const entry = createMemory('batch row survives a mirror failure');
    expect(() => batchWriteAndDelete(root, [entry], [])).not.toThrow();
    expect(readEntry(root, entry.id)).not.toBeNull();
    expect(deleteEntry(root, entry.id)).toBe(true);
    expect(readEntry(root, entry.id)).toBeNull();
  });
});
