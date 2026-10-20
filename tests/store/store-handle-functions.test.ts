// The store functions capture code calls with a folder and plain values: each opens its own handle on a real store.
import { describe, it, expect, beforeEach } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { summarizeFailures } from '../../src/store/sqlite/failure-log.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { duplicateKey } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import type { Captures } from '../../src/store/port/captures.js';
import type { Sync } from '../../src/store/sqlite/served.js';
import { captureExtractedItems } from '../../src/surface/capture/command.js';
import type { ExtractedItem } from '../../src/surface/capture/extract.js';
import { captureTarget } from '../_helpers/cli-stores.js';

let root: string;

beforeEach(() => {
  root = makeRoot('store-handle');
});

function read<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function reject(text: string): void {
  read((db) =>
    insertRejectedValue(db, {
      tenantId: 'default',
      digest: rejectionDigest(text),
      reason: 'wrong',
      rejectedBy: 'cli',
      rejectedAt: new Date().toISOString(),
      normalizedChars: normalizeValueForRejection(text).length,
    }),
  );
}

describe('failure log functions', () => {
  const log = () => sqliteSyncStore(root).failureLog;

  it('record writes a row that a later read finds', () => {
    log().record({
      tenantId: 'default',
      sessionId: 's1',
      tool: 'Bash',
      outcome: 'stored',
      sigHash: 'a',
      detailHash: 'b',
    });
    expect(read((db) => summarizeFailures(db, 'default', '1970-01-01T00:00:00.000Z'))).toMatchObject({
      total: 1,
      sessions: 1,
    });
  });

  it('requestOutcome reads a request outcome and settleOutcome rewrites it', () => {
    log().record({ tenantId: 'default', sessionId: 's1', outcome: 'store-failed', requestId: 'r1' });
    expect(log().requestOutcome('default', 'r1', 's1')).toBe('store-failed');
    log().settleOutcome('default', 'r1', 'stored');
    expect(log().requestOutcome('default', 'r1', 's1')).toBe('stored');
    expect(log().requestOutcome('default', 'unknown', 's1')).toBeNull();
  });
});

describe('compactions.start and compactions.markSnapshotSaved', () => {
  it('inserts a started record and marks its snapshot saved', () => {
    const { compactions } = sqliteSyncStore(root);
    const id = compactions.start('default', {
      sessionId: 's1',
      originProject: 'acme/app',
      trigger: 'auto',
      cwd: null,
      transcriptPath: null,
    });
    const sessionRows = () =>
      read((db) =>
        db
          .prepare(`SELECT id, status, snapshot_saved FROM compactions WHERE tenant_id = ? AND session_id = ?`)
          .all('default', 's1'),
      );
    expect(sessionRows()).toEqual([{ id, status: 'started', snapshot_saved: 0 }]);
    compactions.markSnapshotSaved('default', id);
    expect(sessionRows()).toEqual([{ id, status: 'started', snapshot_saved: 1 }]);
  });
});

describe('compactions.saveCallerItems', () => {
  const req = {
    sessionId: 's1',
    trigger: 'auto',
    requestId: 'req-1',
    project: 'acme/app',
    owner: 'bob@acme',
    origins: ['acme/app'],
    baseHalfLifeDays: 365,
    items: ['The deploy script must run from the repo root, never from a subfolder.'],
  };

  it('writes the items once and answers a retry with the first count', () => {
    const { compactions } = sqliteSyncStore(root);
    expect(compactions.saveCallerItems('default', req)).toEqual({ written: 1, notes: [] });
    expect(compactions.saveCallerItems('default', req)).toEqual({ written: 1, notes: [] });
    expect(loadAllEntries(root, 'default')).toHaveLength(1);
  });
});

describe('captures.write', () => {
  const write = (...args: Parameters<Sync<Captures>['write']>) => sqliteSyncStore(root).captures.write(...args);
  const entry = (content: string) => createMemory(content, { source: 'capture' });

  it('writes each new entry and counts a rejected value', () => {
    const rejected = 'Never cache the session token in local storage.';
    reject(rejected);
    const first = 'Always run the migration dry run before the real one.';
    const outcomes = write([entry(first), entry(rejected)], { lean: true });
    expect(outcomes).toEqual(['captured', 'rejected']);
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual([first]);
  });
});

describe('captureExtractedItems', () => {
  const item = (content: string): ExtractedItem => ({ content, category: 'decision', tags: [] });
  const options = { tenantId: undefined, originProject: undefined, lean: true };
  const capture = (items: ExtractedItem[], keys: Set<string>) =>
    captureExtractedItems(captureTarget(root), options, items, keys);

  it('writes new items, skips a repeat inside the batch and counts a rejected value', async () => {
    const rejected = 'Never cache the session token in local storage.';
    reject(rejected);
    const keys = new Set<string>();
    const first = 'Always run the migration dry run before the real one.';
    expect(await capture([item(first), item(first), item(rejected)], keys)).toEqual({
      captured: 1,
      skipped: 1,
      rejected: 1,
    });
    expect([...keys]).toEqual([duplicateKey(first)]);
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual([first]);
  });

  it('skips an item whose text the store already holds and writes nothing for it', async () => {
    const held = 'Keep the changelog fragment in the same commit as the code.';
    expect(await capture([item(held)], new Set([duplicateKey(held)]))).toEqual({
      captured: 0,
      skipped: 1,
      rejected: 0,
    });
    expect(loadAllEntries(root, 'default')).toEqual([]);
  });
});
