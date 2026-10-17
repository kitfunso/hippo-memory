import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { writeEntry } from '../../src/store/entry-writes.js';
import { readEntry } from '../../src/store/entry-reads.js';
import { batchWriteAndDelete } from '../../src/store/delete-and-batch.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { layerDir, writeMarkdownMirror } from '../../src/store/mirrors.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry } from '../_helpers/root-forms.js';

let root: string;

beforeEach(() => {
  root = makeRoot('mirror');
  // A non-empty store short-circuits initStore's legacy-markdown bootstrap scan,
  // which would otherwise try to read the blocking directory below as a .md file.
  writeEntry(root, createMemory('seed row so legacy bootstrap never rescans'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Writes no longer touch index.json, so the failure vector is a directory at the entry's own .md path.
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

describe('mirror files are replaced whole', () => {
  it('writeMarkdownMirror leaves the new content and no temp file beside it', () => {
    const entry = createMemory('first wording of the mirror');
    writeMarkdownMirror(root, entry);
    writeMarkdownMirror(root, { ...entry, content: 'second wording of the mirror' });
    const dir = layerDir(root, entry.layer);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(entry.id))).toEqual([`${entry.id}.md`]);
    expect(fs.readFileSync(path.join(dir, `${entry.id}.md`), 'utf8')).toContain('second wording of the mirror');
  });

  it('a write that cannot rename onto its target throws and leaves no temp file', () => {
    const entry = createMemory('blocked mirror');
    blockMarkdownMirror(entry.id, entry.layer);
    expect(() => writeMarkdownMirror(root, entry)).toThrow();
    expect(fs.readdirSync(layerDir(root, entry.layer)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
