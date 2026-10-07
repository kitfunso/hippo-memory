import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { deleteEntry, batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mirror-'));
  initStore(root);
  // A non-empty store short-circuits initStore's legacy-markdown bootstrap scan,
  // which would otherwise try to read the blocking directory below as a .md file.
  writeEntry(root, createMemory('seed row so legacy bootstrap never rescans'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// writes no longer touch index.json per call (only rebuildIndex does), so the
// failure vector is the markdown mirror: a directory at the entry's own .md path.
function blockMarkdownMirror(entryId: string, layer: string): void {
  fs.mkdirSync(path.join(root, layer, `${entryId}.md`));
}

describe('mirror write failures after COMMIT', () => {
  it('writeEntry keeps the committed row and warns instead of throwing', () => {
    const entry = createMemory('mirror failure keeps the row');
    blockMarkdownMirror(entry.id, entry.layer);
    expect(() => writeEntry(root, entry)).not.toThrow();
    expect(readEntry(root, entry.id)?.content).toBe('mirror failure keeps the row');
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(`${entry.id}.md`));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('not refreshed'));
  });

  it('batchWriteAndDelete and deleteEntry report their committed changes as done', () => {
    const entry = createMemory('batch row survives a mirror failure');
    blockMarkdownMirror(entry.id, entry.layer);
    expect(() => batchWriteAndDelete(root, [entry], [])).not.toThrow();
    expect(readEntry(root, entry.id)).not.toBeNull();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(`${entry.id}.md`));
    expect(deleteEntry(root, entry.id)).toBe(true);
    expect(readEntry(root, entry.id)).toBeNull();
  });
});
