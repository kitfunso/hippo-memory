// The store functions capture code calls with a folder and plain values: each opens its own handle on a real store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { insertStartedCompactionAt, latestCompactionRows, markSnapshotSavedAt } from '../src/store/compactions.js';
import { failuresBySession, recordFailureAt } from '../src/store/failure-log.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';
import { withRejectionProbe } from '../src/store/rejection-probe.js';

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

describe('recordFailureAt', () => {
  it('writes a failure row that a later read finds', () => {
    recordFailureAt(root, { tenantId: 'default', sessionId: 's1', tool: 'Bash', outcome: 'stored', sigHash: 'a', detailHash: 'b' });
    const rows = read((db) => failuresBySession(db, 'default', '1970-01-01T00:00:00.000Z'));
    expect(rows.map((r) => r.sessionId)).toEqual(['s1']);
  });
});

describe('insertStartedCompactionAt and markSnapshotSavedAt', () => {
  it('inserts a started record and marks its snapshot saved', () => {
    insertStartedCompactionAt(
      root,
      'default',
      { id: 'cmp-1', sessionId: 's1', originProject: 'acme/app', trigger: 'auto', cwd: null, transcriptPath: null, startedAt: '2026-01-01T00:00:00.000Z' },
      2000,
    );
    expect(read((db) => latestCompactionRows(db, 'default', 's1'))[0]).toMatchObject({ id: 'cmp-1', status: 'started', snapshot_saved: 0 });
    markSnapshotSavedAt(root, 'default', 'cmp-1', 2000);
    expect(read((db) => latestCompactionRows(db, 'default', 's1'))[0]?.snapshot_saved).toBe(1);
  });
});

describe('withRejectionProbe', () => {
  it('says true for a rejected value and false for any other', () => {
    const text = 'the build server is at 10.0.0.9';
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
    const answers = withRejectionProbe(root, (wouldReject) => [wouldReject('default', 'm1', text), wouldReject('default', 'm2', 'something else')]);
    expect(answers).toEqual([true, false]);
  });
});
