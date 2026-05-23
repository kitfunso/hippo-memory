/**
 * Runtime tests for api.outcomeForLastRecall (Episode A, Task 3).
 *
 * Validates the documented contract:
 *   - empty last_retrieval_ids returns {applied: 0, ids: []}
 *   - multi-id last_retrieval_ids forwards to api.outcome and reports applied count
 *   - cross-tenant ids in last_retrieval_ids are silently skipped (matches MCP semantics)
 *   - one audit_log row per affected id, tagged with ctx.actor
 *
 * Real-DB per project convention (mkdtempSync + initStore + rmSync cleanup).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadIndex, saveIndex } from '../src/store.js';
import { remember, outcomeForLastRecall, type Context } from '../src/api.js';

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-api-ofr-'));
  initStore(home);
  return home;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

function seedMemory(home: string, content: string, tenantId = 'default'): string {
  const res = remember(
    { hippoRoot: home, tenantId, actor: 'cli' },
    { content, kind: 'distilled' },
  );
  return res.id;
}

function seedLastRetrievalIds(home: string, ids: string[]): void {
  const idx = loadIndex(home);
  idx.last_retrieval_ids = ids;
  saveIndex(home, idx);
}

describe('api.outcomeForLastRecall', () => {
  it('returns {applied:0, ids:[]} when last_retrieval_ids is empty', () => {
    const home = tmpHome();
    try {
      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };
      const result = outcomeForLastRecall(ctx, true);
      expect(result).toEqual({ applied: 0, ids: [] });
    } finally {
      cleanup(home);
    }
  });

  it('applies a positive outcome to every id from the last recall', () => {
    const home = tmpHome();
    try {
      const id1 = seedMemory(home, 'last-recall-mem-1');
      const id2 = seedMemory(home, 'last-recall-mem-2');
      const id3 = seedMemory(home, 'last-recall-mem-3');
      seedLastRetrievalIds(home, [id1, id2, id3]);

      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'cli',
      };
      const result = outcomeForLastRecall(ctx, true);

      expect(result.applied).toBe(3);
      expect(result.ids).toEqual([id1, id2, id3]);
    } finally {
      cleanup(home);
    }
  });

  it('silently skips cross-tenant ids AND filters them out of the response (no leak)', () => {
    const home = tmpHome();
    try {
      // The id belongs to tenant_b. last_retrieval_ids is hippoRoot-level
      // (NOT tenant-scoped at the index layer) so the cross-tenant id can
      // legally appear there. outcome() filters via readEntry(..., tenantId)
      // and silently skips the row — matches MCP outcome semantics for the
      // WRITE path. v1.11.4: also filter the RESPONSE so cross-tenant ids
      // do not leak via the returned `ids` list (fix for the HTTP /v1/outcome
      // no-body last-recall disclosure path; see api.outcome JSDoc).
      const tenantBId = seedMemory(home, 'belongs-to-tenant-b', 'tenant_b');
      seedLastRetrievalIds(home, [tenantBId]);

      const ctxA: Context = {
        hippoRoot: home,
        tenantId: 'tenant_a',
        actor: 'cli',
      };
      const result = outcomeForLastRecall(ctxA, true);

      expect(result.applied).toBe(0);
      // ids must NOT contain tenant_b's id — that would be a cross-tenant
      // ID enumeration vector via the HTTP route.
      expect(result.ids).toEqual([]);
      expect(result.ids).not.toContain(tenantBId);
    } finally {
      cleanup(home);
    }
  });

  it('emits one audit_log row per applied id, tagged with ctx.actor', async () => {
    const home = tmpHome();
    try {
      const id1 = seedMemory(home, 'audit-target-1');
      const id2 = seedMemory(home, 'audit-target-2');
      seedLastRetrievalIds(home, [id1, id2]);

      const ctx: Context = {
        hippoRoot: home,
        tenantId: 'default',
        actor: 'api_key:hk_ofr_test',
      };
      const result = outcomeForLastRecall(ctx, false);
      expect(result.applied).toBe(2);

      const { openHippoDb, closeHippoDb } = await import('../src/db.js');
      const { queryAuditEvents } = await import('../src/audit.js');
      const db = openHippoDb(home);
      try {
        const events = queryAuditEvents(db, {
          tenantId: 'default',
          op: 'outcome',
        });
        expect(events.length).toBe(2);
        expect(events.every((e) => e.actor === 'api_key:hk_ofr_test')).toBe(true);
        const targetIds = events.map((e) => e.targetId).sort();
        expect(targetIds).toEqual([id1, id2].sort());
      } finally {
        closeHippoDb(db);
      }
    } finally {
      cleanup(home);
    }
  });
});
