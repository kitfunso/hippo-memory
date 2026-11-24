import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import { remember, outcomeForLastRecall } from '../../src/api/index.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { recordStatementsAsync, countMatching } from '../_helpers/count-statements.js';
import { apiCtx, onSession } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadLastRecall, saveIndex } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';

function tmpHome(): string {
  const home = makeRoot('api-ofr');
  return home;
}

function cleanup(home: string): void {
  removeDir(home);
}

async function seedMemory(home: string, content: string, tenantId = 'default'): Promise<string> {
  const res = await remember(apiCtx(home, tenantId, { subject: 'cli', role: 'admin' }), { content, kind: 'distilled' });
  return res.id;
}

function seedLastRetrievalIds(home: string, ids: string[]): void {
  const idx = loadLastRecall(home);
  idx.last_retrieval_ids = ids;
  saveIndex(home, idx);
}

describe('api.outcomeForLastRecall', () => {
  it('returns {applied:0, ids:[]} when last_retrieval_ids is empty', async () => {
    const home = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      const result = await outcomeForLastRecall(ctx, true);
      expect(result).toEqual({ applied: 0, ids: [] });
    } finally {
      cleanup(home);
    }
  });

  it('applies a positive outcome to every id from the last recall', async () => {
    const home = tmpHome();
    try {
      const id1 = await seedMemory(home, 'last-recall-mem-1');
      const id2 = await seedMemory(home, 'last-recall-mem-2');
      const id3 = await seedMemory(home, 'last-recall-mem-3');
      seedLastRetrievalIds(home, [id1, id2, id3]);

      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      const result = await outcomeForLastRecall(ctx, true);

      expect(result.applied).toBe(3);
      expect(result.ids).toEqual([id1, id2, id3]);
    } finally {
      cleanup(home);
    }
  });

  it('silently skips cross-tenant ids AND filters them out of the response (no leak)', async () => {
    const home = tmpHome();
    try {
      const tenantBId = await seedMemory(home, 'belongs-to-tenant-b', 'tenant_b');
      seedLastRetrievalIds(home, [tenantBId]);

      const ctxA: FullContext = apiCtx(home, 'tenant_a', { subject: 'cli', role: 'admin' });
      const result = await outcomeForLastRecall(ctxA, true);

      expect(result.applied).toBe(0);
      expect(result.ids).toEqual([]);
      expect(result.ids).not.toContain(tenantBId);
    } finally {
      cleanup(home);
    }
  });

  it('emits one audit_log row per applied id, tagged with ctx.actor', async () => {
    const home = tmpHome();
    try {
      const id1 = await seedMemory(home, 'audit-target-1');
      const id2 = await seedMemory(home, 'audit-target-2');
      seedLastRetrievalIds(home, [id1, id2]);

      const ctx: FullContext = apiCtx(home, 'default', { subject: 'api_key:hk_ofr_test', role: 'admin' });
      const result = await outcomeForLastRecall(ctx, false);
      expect(result.applied).toBe(2);

      const { openHippoDb, closeHippoDb } = await import('../../src/db/index.js');
      const { listAuditEvents } = await import('../../src/store/sqlite/audit/audit.js');
      const db = openHippoDb(home);
      try {
        const events = listAuditEvents(db, {
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

describe('api.outcomeForLastRecall reads', () => {
  it('reads the last recall from meta and only its own rows, never the index of the store', async () => {
    const home = tmpHome();
    try {
      const ids: string[] = [];
      await withSharedStoreHandles(async (session) => {
        const ctx = onSession(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), session);
        for (let i = 0; i < 40; i++) {
          ids.push(
            (await remember(ctx, { content: `bystander or recalled memory number ${i}`, kind: 'distilled' })).id,
          );
        }
      });
      const recalled = [ids[3], ids[17]];
      seedLastRetrievalIds(home, recalled);
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });

      const { result, statements, rowsRead } = await recordStatementsAsync(async () => outcomeForLastRecall(ctx, true));

      expect(result).toEqual({ applied: 2, ids: recalled });
      expect(countMatching(statements, 'FROM memories ORDER BY created ASC, id ASC')).toBe(0);
      expect(countMatching(statements, "FROM meta WHERE key IN ('last_retrieval_ids', 'last_trace_id')")).toBe(1);
      expect(rowsRead).toBeLessThan(ids.length);
    } finally {
      cleanup(home);
    }
  });
});
