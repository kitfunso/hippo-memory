import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../src/db.js';
import { initStore, writeEntry, readEntry, batchWriteAndDelete } from '../src/store.js';
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
});
