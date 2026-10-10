// The store functions capture code calls with a folder and plain values: each opens its own handle on a real store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { latestCompactionRows } from '../src/store/compactions.js';
import { markSnapshotSavedAt, saveCallerItems, startCompactionAt } from '../src/store/compaction-caller.js';
import { failuresBySession } from '../src/store/failure-log.js';
import { recordFailureAt, requestOutcomeAt, settleFailureOutcomeAt } from '../src/store/failure-log-at.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';
import { withRejectionProbe } from '../src/store/rejection-probe.js';
import { writeCapturedItems } from '../src/store/capture-write.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { duplicateKey } from '../src/util/same-text.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-store-handle-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function read<T>(fn: (db: ReturnType<typeof openHippoDb>) => T): T {
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
  it('recordFailureAt writes a row that a later read finds', () => {
    recordFailureAt(root, { tenantId: 'default', sessionId: 's1', tool: 'Bash', outcome: 'stored', sigHash: 'a', detailHash: 'b' });
    expect(read((db) => failuresBySession(db, 'default', '1970-01-01T00:00:00.000Z')).map((r) => r.sessionId)).toEqual(['s1']);
  });

  it('requestOutcomeAt reads a request outcome and settleFailureOutcomeAt rewrites it', () => {
    recordFailureAt(root, { tenantId: 'default', sessionId: 's1', outcome: 'store-failed', requestId: 'r1' });
    expect(requestOutcomeAt(root, 'default', 'r1', 's1')).toBe('store-failed');
    settleFailureOutcomeAt(root, 'default', 'r1', 'stored');
    expect(requestOutcomeAt(root, 'default', 'r1', 's1')).toBe('stored');
    expect(requestOutcomeAt(root, 'default', 'unknown', 's1')).toBeNull();
  });
});

describe('startCompactionAt and markSnapshotSavedAt', () => {
  it('inserts a started record and marks its snapshot saved', () => {
    const id = startCompactionAt(root, 'default', { sessionId: 's1', originProject: 'acme/app', trigger: 'auto', cwd: null, transcriptPath: null });
    expect(read((db) => latestCompactionRows(db, 'default', 's1'))[0]).toMatchObject({ id, status: 'started', snapshot_saved: 0 });
    markSnapshotSavedAt(root, 'default', id);
    expect(read((db) => latestCompactionRows(db, 'default', 's1'))[0]?.snapshot_saved).toBe(1);
  });
});

describe('saveCallerItems', () => {
  const req = {
    sessionId: 's1', trigger: 'auto', requestId: 'req-1', project: 'acme/app', owner: 'bob@acme', origins: ['acme/app'],
    items: ['The deploy script must run from the repo root, never from a subfolder.'],
  };

  it('writes the items once and answers a retry with the first count', () => {
    expect(saveCallerItems(root, 'default', req, () => undefined)).toBe(1);
    expect(saveCallerItems(root, 'default', req, () => undefined)).toBe(1);
    expect(loadAllEntries(root, 'default')).toHaveLength(1);
  });
});

describe('withRejectionProbe', () => {
  it('says true for a rejected value and false for any other', () => {
    const text = 'the build server is at 10.0.0.9';
    reject(text);
    const answers = withRejectionProbe(root, (wouldReject) => [wouldReject('default', 'm1', text), wouldReject('default', 'm2', 'something else')]);
    expect(answers).toEqual([true, false]);
  });
});

describe('writeCapturedItems', () => {
  const item = (content: string) => ({ content, makeEntry: () => createMemory(content, { source: 'capture' }) });

  it('writes new items, skips a repeat inside the batch and counts a rejected value', () => {
    const rejected = 'Never cache the session token in local storage.';
    reject(rejected);
    const keys = new Set<string>();
    const first = 'Always run the migration dry run before the real one.';
    const outcomes = writeCapturedItems(root, [item(first), item(first), item(rejected)], keys, { lean: true });
    expect(outcomes).toEqual(['captured', 'skipped', 'rejected']);
    expect(keys.has(duplicateKey(first))).toBe(true);
    expect(loadAllEntries(root, 'default').map((e) => e.content)).toEqual([first]);
  });

  it('skips an item whose text the store already holds without building its entry', () => {
    const held = 'Keep the changelog fragment in the same commit as the code.';
    let built = false;
    const outcomes = writeCapturedItems(root, [{ content: held, makeEntry: () => ((built = true), createMemory(held)) }], new Set([duplicateKey(held)]), { lean: true });
    expect(outcomes).toEqual(['skipped']);
    expect(built).toBe(false);
  });
});
