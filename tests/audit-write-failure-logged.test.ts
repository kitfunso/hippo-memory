// An audit row that fails to write must not undo the mutation, and must not vanish silently either.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { createMemory } from '../src/core/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { auditWriteFailureCount } from '../src/store/audit.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-audit-fail-'));
  initStore(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function breakAuditTable(): void {
  const db = openHippoDb(root);
  try {
    db.exec(`CREATE TRIGGER audit_log_broken BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);
  } finally {
    closeHippoDb(db);
  }
}

describe('audit write failure', () => {
  it('keeps the forget, logs one error line with the target id, and counts it', () => {
    const entry = createMemory('the staging cluster runs on the old node pool', { baseHalfLifeDays: 30 });
    writeEntry(root, entry);
    breakAuditTable();
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const before = auditWriteFailureCount();

    expect(deleteEntry(root, entry.id)).toBe(true);

    expect(readEntry(root, entry.id)).toBeNull();
    const errors = lines.filter((l) => l.includes('audit write failed'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('error:');
    expect(errors[0]).toContain('op=forget');
    expect(errors[0]).toContain(`target=${entry.id}`);
    expect(auditWriteFailureCount()).toBe(before + 1);
  });
});
