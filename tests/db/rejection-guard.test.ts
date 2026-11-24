import { describe, it, expect } from 'vitest';
import { openHippoDb, closeHippoDb, getSchemaVersion } from '../../src/db/index.js';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { insertRejectedValue } from '../../src/store/sqlite/review/rejection.js';
import { rejectionDigest, normalizeValueForRejection } from '../../src/base/records/rejection-digest.js';
import { identityText } from '../../src/base/util/same-text.js';
import { RejectedValueError } from '../../src/base/errors/api-errors.js';
import { DIGEST_DISPLAY_CHARS } from '../../src/base/util/token-text.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { makeRoot } from '../_helpers/make-root.js';
import { deleteEntry, applyRebuildResult, readEntry, batchWriteAndDeleteInFolder } from '../_helpers/root-forms.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry } = sessionPerTest();

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

describe('rejection guard', () => {
  it('fresh store migrates to schema_version 41', () => {
    const home = makeRoot('rejection');
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      closeHippoDb(db);
    }
  });

  it('guarded new-row write of a rejected value throws RejectedValueError', () => {
    const home = makeRoot('rejection');
    reject(home, 'secret api key: sk-12345', 'leaked credential');

    const entry = createMemory('secret api key: sk-12345', { layer: Layer.Episodic });
    expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
    expect(readEntry(home, entry.id)).toBeNull();
  });

  it('same-id content-change onto a rejected value throws and leaves the original row untouched', () => {
    const home = makeRoot('rejection');
    const original = createMemory('original safe content', { layer: Layer.Episodic });
    writeEntry(home, original);

    const rejectedText = 'now a rejected value';
    reject(home, rejectedText, 'bad edit');

    const edited = { ...original, content: rejectedText };
    expect(() => writeEntry(home, edited)).toThrow(RejectedValueError);

    const stored = readEntry(home, original.id);
    expect(stored!.content).toBe('original safe content');
  });

  it('unchanged same-id re-persist of an already-tombstoned value succeeds (exempt by construction)', () => {
    const home = makeRoot('rejection');
    const entry = createMemory('boosted fact', { layer: Layer.Episodic });
    writeEntry(home, entry);
    reject(home, 'boosted fact', 'created after the row existed');

    const boosted = { ...entry, retrievalCount: entry.retrievalCount + 1 };
    expect(() => writeEntry(home, boosted)).not.toThrow();
    expect(readEntry(home, entry.id)!.retrievalCount).toBe(entry.retrievalCount + 1);
  });

  it('batchWriteAndDelete probes for a rejected value in-transaction and skips a re-persist that races a reject, instead of resurrecting it', () => {
    const home = makeRoot('rejection');
    const raceText = 'batch race content rejected between the producer check and the batch commit';
    const entry = createMemory(raceText, { layer: Layer.Semantic });
    writeEntry(home, entry);

    const queuedRePersist = { ...entry, retrievalCount: entry.retrievalCount + 1 };

    deleteEntry(home, entry.id);
    const digest = reject(home, raceText, 'rejected mid-race, between producer check and batch commit');
    expect(readEntry(home, entry.id)).toBeNull();

    expect(() => batchWriteAndDeleteInFolder(home, [queuedRePersist], [])).not.toThrow();
    expect(readEntry(home, entry.id)).toBeNull();

    const db = openHippoDb(home);
    try {
      const refusals = listAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
      expect(refusals.length).toBe(1);
      expect(refusals[0]!.targetId).toBe(entry.id);
      expect(refusals[0]!.metadata.digest).toBe(digest);
      expect(refusals[0]!.actor).toBe('sleep-batch');
    } finally {
      closeHippoDb(db);
    }
  });

  it('normalization variants (case, whitespace) are refused by the same tombstone', () => {
    const home = makeRoot('rejection');
    reject(home, 'The Sky Is Blue', 'canonical form rejected');

    const variants = ['the sky is blue', '  the   sky is   blue  ', 'THE SKY IS BLUE'];
    for (const variant of variants) {
      const entry = createMemory(variant, { layer: Layer.Episodic });
      expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
    }
  });

  it('a refused writeEntry leaves exactly one reject_refusal audit row and no memory row', () => {
    const home = makeRoot('rejection');
    const text = 'never store my key again';
    const digest = reject(home, text, 'secret');

    const entry = createMemory(text, { layer: Layer.Episodic });
    expect(() => writeEntry(home, entry)).toThrow(RejectedValueError);
    expect(readEntry(home, entry.id)).toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = listAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
      expect(rows.length).toBe(1);
      expect(rows[0]!.targetId).toBe(entry.id);
      expect(rows[0]!.metadata.digest).toBe(digest);
    } finally {
      closeHippoDb(db);
    }
  });

  it('applyRebuildResult refuses a rebuild patch matching a rejected value: old content survives, dirty cleared, one reject_refusal audit, no loop on second run', async () => {
    const home = makeRoot('rejection');
    const summary = createMemory('old summary content', {
      layer: Layer.Semantic,
      dagLevel: 2,
      confidence: 'inferred',
    });
    writeEntry(home, summary);

    const rejectedContent = 'rebuilt content that was already rejected';
    reject(home, rejectedContent, 'known-bad rebuild output');

    const dbSetup = openHippoDb(home);
    try {
      dbSetup.prepare(`UPDATE memories SET summary_dirty = 1 WHERE id = ?`).run(summary.id);
    } finally {
      closeHippoDb(dbSetup);
    }

    const loaded = readEntry(home, summary.id)!;
    const result1 = await applyRebuildResult(home, loaded, {
      now: evalNow(),
      content: rejectedContent,
      descendantCount: 3,
      earliestAt: '2026-08-01T00:00:00Z',
      latestAt: '2026-08-02T00:00:00Z',
      bumpRebuildCount: true,
      zeroChildren: false,
      actor: 'sleep',
    });

    expect(result1.changed).toBe(true);
    expect(result1.refused).toBe(true);

    const after = readEntry(home, summary.id)!;
    expect(after.content).toBe('old summary content');
    expect(after.summaryDirty).toBe(false);
    expect(after.rebuildCount).toBe(0);
    expect(after.descendantCount).toBe(3);

    const db = openHippoDb(home);
    try {
      const refusals = listAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
      expect(refusals.length).toBe(1);
      expect(refusals[0]!.targetId).toBe(summary.id);
    } finally {
      closeHippoDb(db);
    }

    const result2 = await applyRebuildResult(home, after, {
      now: evalNow(),
      content: rejectedContent,
      descendantCount: 3,
      earliestAt: '2026-08-01T00:00:00Z',
      latestAt: '2026-08-02T00:00:00Z',
      bumpRebuildCount: true,
      zeroChildren: false,
      actor: 'sleep',
    });
    expect(result2.changed).toBe(false);
    expect(result2.refused).toBe(false);

    const db2 = openHippoDb(home);
    try {
      const refusals2 = listAuditEvents(db2, { tenantId: 'default', op: 'reject_refusal' });
      expect(refusals2.length).toBe(1);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('a same-id upsert that only changes tenantId is refused when the destination tenant rejected the unchanged content', () => {
    const home = makeRoot('rejection');
    const entry = createMemory('shared content across a tenant move', { layer: Layer.Episodic });
    entry.tenantId = 'tenant-a';
    writeEntry(home, entry);
    expect(readEntry(home, entry.id, 'tenant-a')).not.toBeNull();

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

    const moved = { ...entry, tenantId: 'tenant-b' };
    expect(() => writeEntry(home, moved)).toThrow(RejectedValueError);

    expect(readEntry(home, entry.id, 'tenant-a')!.content).toBe('shared content across a tenant move');
    expect(readEntry(home, entry.id, 'tenant-b')).toBeNull();
  });
});

describe('rejection guard on rows with a lead-in', () => {
  const [L1, L2, L3] = ['user: Is the flight booked?', 'user: Did Mel get the job?', 'user: Is the hotel paid?'];
  const yes = (leadIn?: string) => createMemory('Yes.', { layer: Layer.Episodic, leadIn });

  it('an identity tombstone refuses that text with that lead-in only', () => {
    const home = makeRoot('rejection');
    reject(home, identityText(yes(L1)), 'wrong answer');

    expect(() => writeEntry(home, yes(L1))).toThrow(RejectedValueError);
    expect(() => writeEntry(home, yes(`  ${L1.replace(/ /g, '   ')}`))).toThrow(RejectedValueError);
    for (const leadIn of [L2, undefined]) expect(() => writeEntry(home, yes(leadIn))).not.toThrow();
  });

  it('a content tombstone refuses that text with any lead-in', () => {
    const home = makeRoot('rejection');
    reject(home, 'Yes.', 'never say it');

    for (const leadIn of [L1, L3, undefined]) expect(() => writeEntry(home, yes(leadIn))).toThrow(RejectedValueError);
  });

  it('says "under this lead-in" for an identity refusal and keeps the value message for a content one', () => {
    const refusal = (home: string, leadIn: string): RejectedValueError => {
      try {
        writeEntry(home, yes(leadIn));
      } catch (err) {
        if (err instanceof RejectedValueError) return err;
        throw err;
      }
      throw new Error('expected the write to be refused');
    };
    const tail = (digest: string, reason: string): string =>
      `(digest ${digest.slice(0, DIGEST_DISPLAY_CHARS)}..., reason: ${reason}). Run "hippo unreject" to allow it again.`;

    const scopedHome = makeRoot('rejection');
    const scopedDigest = reject(scopedHome, identityText(yes(L1)), 'wrong answer');
    const scoped = refusal(scopedHome, L1);
    expect(scoped.leadInScoped).toBe(true);
    expect(scoped.message).toBe(
      `Memory refused: this text under this lead-in matches a rejected memory ${tail(scopedDigest, 'wrong answer')}`,
    );

    const wideHome = makeRoot('rejection');
    const wideDigest = reject(wideHome, 'Yes.', 'never say it');
    const wide = refusal(wideHome, L1);
    expect(wide.leadInScoped).toBe(false);
    expect(wide.message).toBe(`Memory value refused: matches a rejected value ${tail(wideDigest, 'never say it')}`);
  });

  it('refuses a same-id edit that only moves the row onto a tombstoned lead-in, and spares an unchanged re-persist', () => {
    const home = makeRoot('rejection');
    const held = yes(L1);
    const sibling = yes(L2);
    writeEntry(home, held);
    writeEntry(home, sibling);
    reject(home, identityText(held), 'wrong answer');

    expect(() => writeEntry(home, { ...sibling, leadIn: L1 })).toThrow(RejectedValueError);
    expect(readEntry(home, sibling.id)!.leadIn).toBe(L2);
    expect(() => writeEntry(home, { ...held, retrievalCount: held.retrievalCount + 1 })).not.toThrow();
  });

  it('batchWriteAndDelete skips a row whose identity is tombstoned and writes its sibling', () => {
    const home = makeRoot('rejection');
    const refused = yes(L1);
    const sibling = yes(L2);
    const digest = reject(home, identityText(refused), 'wrong answer');

    batchWriteAndDeleteInFolder(home, [refused, sibling], []);

    expect(readEntry(home, refused.id)).toBeNull();
    expect(readEntry(home, sibling.id)).not.toBeNull();
    const db = openHippoDb(home);
    try {
      const refusals = listAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' });
      expect(refusals.map((r) => [r.targetId, r.metadata.digest])).toEqual([[refused.id, digest]]);
    } finally {
      closeHippoDb(db);
    }
  });
});
