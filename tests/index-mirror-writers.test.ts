import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, batchWriteAndDelete, deleteEntry, loadIndex, saveIndex, rebuildIndex, type HippoIndex } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { rejectValue } from '../src/reject-flow.js';

let root: string;
const indexPath = (): string => path.join(root, 'index.json');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-index-mirror-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Pins the write-path-cost fix: index.json is written by exactly one path, rebuildIndex.
// Each write site gets its own test so re-adding a writeIndexMirror to any one turns it red.
describe('index.json is written only by rebuildIndex', () => {
  it('writeEntry leaves no index.json', () => {
    writeEntry(root, createMemory('writeEntry leaves index.json alone'));
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('batchWriteAndDelete leaves no index.json', () => {
    batchWriteAndDelete(root, [createMemory('batch leaves index.json alone')], []);
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('deleteEntry leaves no index.json', () => {
    const entry = createMemory('delete leaves index.json alone');
    writeEntry(root, entry);
    deleteEntry(root, entry.id);
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('saveIndex leaves no index.json', () => {
    writeEntry(root, createMemory('saveIndex leaves index.json alone'));
    saveIndex(root, loadIndex(root));
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('reject leaves no index.json', () => {
    const entry = createMemory('reject leaves index.json alone');
    writeEntry(root, entry);
    rejectValue({ hippoRoot: root, tenantId: entry.tenantId, actor: 'test', reason: 'index-mirror-writers test', memoryId: entry.id });
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('a pre-existing index.json is byte-identical after every write path runs', () => {
    const sentinel = 'not valid json, just a sentinel that must survive untouched';
    fs.writeFileSync(indexPath(), sentinel, 'utf8');

    writeEntry(root, createMemory('sentinel writeEntry'));
    batchWriteAndDelete(root, [createMemory('sentinel batch')], []);
    const toDelete = createMemory('sentinel delete');
    writeEntry(root, toDelete);
    deleteEntry(root, toDelete.id);
    saveIndex(root, loadIndex(root));
    const toReject = createMemory('sentinel reject');
    writeEntry(root, toReject);
    rejectValue({ hippoRoot: root, tenantId: toReject.tenantId, actor: 'test', reason: 'sentinel', memoryId: toReject.id });

    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(sentinel);
  });

  it('rebuildIndex writes index.json and its entries match loadIndex', () => {
    writeEntry(root, createMemory('rebuildIndex writes the mirror'));
    expect(fs.existsSync(indexPath())).toBe(false);

    const rebuilt = rebuildIndex(root);
    expect(fs.existsSync(indexPath())).toBe(true);

    // SAFETY: this file was just written by rebuildIndex via writeIndexMirror(hippoRoot, HippoIndex).
    const onDisk = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as HippoIndex;
    const expectedKeys = Object.keys(loadIndex(root).entries).sort();
    expect(Object.keys(onDisk.entries).sort()).toEqual(expectedKeys);
    expect(Object.keys(rebuilt.entries).sort()).toEqual(expectedKeys);
  });
});
