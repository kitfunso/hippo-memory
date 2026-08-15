import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db.js';
import { initStore, writeEntry, readEntry, batchWriteAndDelete, applyRebuildResult } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { queryAuditEvents } from '../src/audit.js';
import {
  insertRejectedValue,
  rejectionDigest,
  normalizeValueForRejection,
  RejectedValueError,
} from '../src/rejection.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'hippo-rejection-'));
}

function reject(home: string, text: string, reason: string): string {
  const digest = rejectionDigest(text);
  const db = openHippoDb(home);
  try {
    insertRejectedValue(db, {
      tenantId: 'default',
      digest,
      reason,
      rejectedBy: 'cli',
      rejectedAt: new Date().toISOString(),
      normalizedChars: normalizeValueForRejection(text).length,
    });
  } finally {
    closeHippoDb(db);
  }
  return digest;
}

describe('AT1 rejection guard', () => {
  it('fresh store migrates to schema_version 41', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const db = openHippoDb(home);
      try {
        expect(getSchemaVersion(db)).toBe(41);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('guarded new-row write of a rejected value throws RejectedValueError', () => {
    const home = tmpHome();
    try {
      initStore(home);
      reject(home, 'secret api key: sk-12345', 'leaked credential');

      const entry = createMemory('secret api key: sk-12345', { layer: Layer.Episodic });
      expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
      expect(readEntry(home, entry.id)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('same-id content-change onto a rejected value throws and leaves the original row untouched', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const original = createMemory('original safe content', { layer: Layer.Episodic });
      writeEntry(home, original);

      const rejectedText = 'now a rejected value';
      reject(home, rejectedText, 'bad edit');

      const edited = { ...original, content: rejectedText };
      expect(() => writeEntry(home, edited)).toThrow(RejectedValueError);

      const stored = readEntry(home, original.id);
      expect(stored!.content).toBe('original safe content');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('unchanged same-id re-persist of an already-tombstoned value succeeds (exempt by construction)', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const entry = createMemory('boosted fact', { layer: Layer.Episodic });
      writeEntry(home, entry); // lands before any tombstone exists

      // Reject the SAME value the row already holds (e.g. a reject created
      // after the row existed). A recall-boost re-persist of the unchanged
      // content must not be refused.
      reject(home, 'boosted fact', 'created after the row existed');

      const boosted = { ...entry, retrieval_count: entry.retrieval_count + 1 };
      expect(() => writeEntry(home, boosted)).not.toThrow();
      expect(readEntry(home, entry.id)!.retrieval_count).toBe(entry.retrieval_count + 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('batchWriteAndDelete bypasses the rejection guard (consolidation rollups)', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const rollupText = 'rollup text that happens to match a tombstone';
      reject(home, rollupText, 'coincidental digest match');

      const entry = createMemory(rollupText, { layer: Layer.Semantic });
      expect(() => batchWriteAndDelete(home, [entry], [])).not.toThrow();
      expect(readEntry(home, entry.id)!.content).toBe(rollupText);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('normalization variants (case, whitespace) are refused by the same tombstone', () => {
    const home = tmpHome();
    try {
      initStore(home);
      reject(home, 'The Sky Is Blue', 'canonical form rejected');

      const variants = ['the sky is blue', '  the   sky is   blue  ', 'THE SKY IS BLUE'];
      for (const variant of variants) {
        const entry = createMemory(variant, { layer: Layer.Episodic });
        expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a refused writeEntry leaves exactly one reject_refusal audit row and no memory row', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const text = 'never store my key again';
      const digest = reject(home, text, 'secret');

      const entry = createMemory(text, { layer: Layer.Episodic });
      expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
      expect(readEntry(home, entry.id)).toBeNull();

      const db = openHippoDb(home);
      try {
        const rows = queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
        expect(rows.length).toBe(1);
        expect(rows[0]!.targetId).toBe(entry.id);
        expect(rows[0]!.metadata.digest).toBe(digest);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('applyRebuildResult refuses a rebuild patch matching a rejected value: old content survives, dirty cleared, one reject_refusal audit, no loop on second run (P1a fix)', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const summary = createMemory('old summary content', {
        layer: Layer.Semantic,
        dag_level: 2,
        confidence: 'inferred',
      });
      writeEntry(home, summary);

      const rejectedContent = 'rebuilt content that was already rejected';
      reject(home, rejectedContent, 'known-bad rebuild output');

      // Force the summary dirty — rebuildDirtySummaries' normal trigger is a
      // child write under it; this test drives applyRebuildResult directly.
      const dbSetup = openHippoDb(home);
      try {
        dbSetup.prepare(`UPDATE memories SET summary_dirty = 1 WHERE id = ?`).run(summary.id);
      } finally {
        closeHippoDb(dbSetup);
      }

      const loaded = readEntry(home, summary.id)!;
      const changed = applyRebuildResult(home, loaded, {
        content: rejectedContent,
        descendant_count: 3,
        earliest_at: '2026-08-01T00:00:00Z',
        latest_at: '2026-08-02T00:00:00Z',
        bumpRebuildCount: true,
        zeroChildren: false,
        actor: 'sleep',
      });

      // Documented return-value semantics: metadata still applied → true,
      // even though content was refused.
      expect(changed).toBe(true);

      const after = readEntry(home, summary.id)!;
      expect(after.content).toBe('old summary content');
      expect(after.summary_dirty).toBe(0);
      expect(after.rebuild_count).toBe(0);
      expect(after.descendant_count).toBe(3); // metadata DID apply

      const db = openHippoDb(home);
      try {
        const refusals = queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusals.length).toBe(1);
        expect(refusals[0]!.targetId).toBe(summary.id);
      } finally {
        closeHippoDb(db);
      }

      // No loop: dirty is cleared, so a second attempt against the
      // now-current row (summary_dirty=1 no longer matches) is a race-loser
      // no-op — no second refusal audit.
      const secondPass = applyRebuildResult(home, after, {
        content: rejectedContent,
        descendant_count: 3,
        earliest_at: '2026-08-01T00:00:00Z',
        latest_at: '2026-08-02T00:00:00Z',
        bumpRebuildCount: true,
        zeroChildren: false,
        actor: 'sleep',
      });
      expect(secondPass).toBe(false);

      const db2 = openHippoDb(home);
      try {
        const refusals2 = queryAuditEvents(db2, { tenantId: 'default', op: 'reject_refusal' });
        expect(refusals2.length).toBe(1); // still just one — no loop
      } finally {
        closeHippoDb(db2);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a same-id upsert that only changes tenantId is refused when the destination tenant rejected the unchanged content (P2 fix)', () => {
    const home = tmpHome();
    try {
      initStore(home);
      // Content lives quietly in tenant A — never rejected there.
      const entry = createMemory('shared content across a tenant move', { layer: Layer.Episodic });
      entry.tenantId = 'tenant-a';
      writeEntry(home, entry);
      expect(readEntry(home, entry.id, 'tenant-a')).not.toBeNull();

      // Tenant B rejects the SAME (byte-identical) content.
      const db = openHippoDb(home);
      try {
        insertRejectedValue(db, {
          tenantId: 'tenant-b',
          digest: rejectionDigest('shared content across a tenant move'),
          reason: 'rejected in tenant B',
          rejectedBy: 'cli',
          rejectedAt: new Date().toISOString(),
          normalizedChars: normalizeValueForRejection('shared content across a tenant move').length,
        });
      } finally {
        closeHippoDb(db);
      }

      // Same id, SAME content — only tenantId changes A -> B.
      const moved = { ...entry, tenantId: 'tenant-b' };
      expect(() => writeEntry(home, moved)).toThrow(RejectedValueError);

      // The row stays in tenant A, untouched.
      expect(readEntry(home, entry.id, 'tenant-a')!.content).toBe('shared content across a tenant move');
      expect(readEntry(home, entry.id, 'tenant-b')).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
