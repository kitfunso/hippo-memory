import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { batchWriteAndDelete, deleteEntry } from '../src/store/delete-and-batch.js';
import { loadLastRecall, saveIndex } from '../src/store/index-and-stats.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { rejectValue } from '../src/trust/reject-flow.js';

let root: string;
const indexPath = (): string => path.join(root, 'index.json');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-index-mirror-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Pins the write-path-cost fix: no hippo path writes index.json.
// Each write site gets its own test so re-adding a writeIndexMirror to any one turns it red.
describe('index.json is written by no hippo path', () => {
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
    saveIndex(root, loadLastRecall(root));
    expect(fs.existsSync(indexPath())).toBe(false);
  });

  it('reject leaves no index.json', () => {
    const entry = createMemory('reject leaves index.json alone');
    writeEntry(root, entry);
    rejectValue({ hippoRoot: root, tenantId: entry.tenant_id, actor: 'test', reason: 'index-mirror-writers test', memoryId: entry.id });
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
    saveIndex(root, loadLastRecall(root));
    const toReject = createMemory('sentinel reject');
    writeEntry(root, toReject);
    rejectValue({ hippoRoot: root, tenantId: toReject.tenant_id, actor: 'test', reason: 'sentinel', memoryId: toReject.id });

    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(sentinel);
  });
});
