import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { handleMessageDeleted } from '../src/connectors/slack/deletion.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'connector:slack' });

describe('handleMessageDeleted', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-slack-del-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('archives the matching kind=raw row via archiveRawMemory', () => {
    const ingested = ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U1', text: 'doomed', ts: '1700.0001' },
      eventId: 'Ev1',
    });
    expect(ingested.status).toBe('ingested');

    const result = handleMessageDeleted(ctx(root), {
      teamId: 'T1',
      channelId: 'C1',
      deletedTs: '1700.0001',
      eventId: 'EvDel1',
    });
    expect(result.status).toBe('archived');

    const remaining = loadAllEntries(root).filter((e) => e.id === ingested.memoryId);
    expect(remaining).toHaveLength(0);

    // raw_archive table now has the row.
    const db = openHippoDb(root);
    try {
      const arch = db.prepare(`SELECT memory_id, reason FROM raw_archive WHERE memory_id = ?`).get(ingested.memoryId!) as Record<string, unknown>;
      expect(arch).toBeDefined();
      expect(String(arch.reason)).toContain('source_deleted');
    } finally { closeHippoDb(db); }
  });

  it('returns not_found for unknown artifact_ref (idempotent on replay)', () => {
    const r = handleMessageDeleted(ctx(root), {
      teamId: 'T1', channelId: 'C1', deletedTs: '9999.9999', eventId: 'EvDel2',
    });
    expect(r.status).toBe('not_found');
  });

  it('cross-tenant deletion event cannot archive another tenants row (review patch #1)', () => {
    // Ingest under tenant 'acme'.
    const acmeCtx = { hippoRoot: root, tenantId: 'acme', actor: 'connector:slack' };
    const ingested = ingestMessage(acmeCtx, {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U1', text: 'acme secret', ts: '1700.0001' },
      eventId: 'EvAcme1',
    });
    expect(ingested.status).toBe('ingested');

    // Fire deletion under tenant 'default' for the same artifact_ref.
    const defaultCtx = { hippoRoot: root, tenantId: 'default', actor: 'connector:slack' };
    const r = handleMessageDeleted(defaultCtx, {
      teamId: 'T1', channelId: 'C1', deletedTs: '1700.0001', eventId: 'EvDelCross',
    });
    expect(r.status).toBe('not_found');

    // Acme row is still there; raw_archive has no row.
    const remaining = loadAllEntries(root).filter((e) => e.id === ingested.memoryId);
    expect(remaining).toHaveLength(1);
    const db = openHippoDb(root);
    try {
      const archCount = db.prepare(`SELECT COUNT(*) as c FROM raw_archive WHERE memory_id = ?`).get(ingested.memoryId!) as { c: number };
      expect(Number(archCount.c)).toBe(0);
    } finally { closeHippoDb(db); }
  });
});
