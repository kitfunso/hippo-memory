// The conflict list is one JOIN read per page: pages join up to the whole list, statements do not grow with
// conflicts, and a pair holding a row the caller cannot touch never shows on any page.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  everyConflict,
  getConflict,
  listConflicts,
  listOpenConflicts,
  remember,
  type Actor,
  type ConflictPageOptions,
} from '../../src/api/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import type { KeysetPosition } from '../../src/util/keyset.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';

let root: string;
const actorA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };
const actorB: Actor = { subject: 'api_key:hk_b', role: 'member', owner: 'b' };

beforeEach(() => {
  root = makeRoot('conflict-list-pages', { config: { embeddings: { enabled: false } } });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const conflictOf = (a: string, b: string) => ({ memory_a_id: a, memory_b_id: b, reason: 'contradiction', score: 0.9 });

/** `n` open conflicts between team rows, plus `extra`, all detected at one instant so the pages must break ties on id. */
function seedTeamConflicts(n: number, tenantId = 'default', extra: ReturnType<typeof conflictOf>[] = []): void {
  const rows = Array.from({ length: 2 * n }, (_, i) =>
    createMemory(`deploy rule number ${i} for tenant ${tenantId}`, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tenantId,
    }),
  );
  writeEntriesTogether(root, rows);
  const pairs = Array.from({ length: n }, (_, i) => conflictOf(rows[2 * i]!.id, rows[2 * i + 1]!.id));
  replaceDetectedConflicts(root, [...pairs, ...extra], '2026-10-17T00:00:00.000Z');
}

async function walk(
  read: (page: ConflictPageOptions) => Promise<{ conflicts: { id: number }[]; next: KeysetPosition | null }>,
  limit: number,
): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = [];
  let pages = 0;
  let after: KeysetPosition | undefined;
  do {
    const page = await read({ limit, after });
    ids.push(...page.conflicts.map((c) => c.id));
    pages += 1;
    after = page.next ?? undefined;
  } while (after);
  return { ids, pages };
}

describe('conflict list pages', () => {
  it('reads 9 conflicts in 3 pages of 3 that join up to the unpaged list', async () => {
    seedTeamConflicts(9);
    const ctx = apiCtx(root);
    const whole = (await listConflicts(ctx, 'open', {}, { limit: 1000 })).conflicts.map((c) => c.id);
    expect(whole).toHaveLength(9);
    const paged = await walk((page) => listConflicts(ctx, 'open', {}, page), 3);
    expect(paged.pages).toBe(3);
    expect(paged.ids).toEqual(whole);
    expect((await everyConflict((page) => listOpenConflicts(ctx, page))).map((c) => c.id)).toEqual(whole);
  });

  it('refuses a limit past the cap or below one', async () => {
    const ctx = apiCtx(root);
    await expect(listOpenConflicts(ctx, { limit: 1001 })).rejects.toThrow(/limit/);
    await expect(listOpenConflicts(ctx, { limit: 0 })).rejects.toThrow(/limit/);
  });

  it('lists 5 or 50 conflicts in the same statements, one JOIN and no per-conflict read', async () => {
    const count = async (n: number): Promise<string[]> => {
      seedTeamConflicts(n);
      const ctx = apiCtx(root);
      const { result, statements } = await recordStatementsAsync(() => listOpenConflicts(ctx));
      expect(result.conflicts).toHaveLength(n);
      return statements;
    };
    const five = await count(5);
    const fifty = await count(50);
    expect(countMatching(fifty, 'FROM memory_conflicts')).toBe(1);
    expect(countMatching(fifty, /FROM memories WHERE/)).toBe(0);
    // The store open's pragmas and schema probe, then the one JOIN.
    expect(fifty).toHaveLength(five.length);
    expect(fifty.filter((sql) => !sql.startsWith('PRAGMA'))).toHaveLength(2);
  });

  it('never shows a tenant key a pair whose other row it cannot touch, on any page', async () => {
    const bPersonal = (
      await remember(apiCtx(root, 'default', actorB), { content: 'b private deploy rule', personal: true })
    ).id;
    const aTeam = (await remember(apiCtx(root, 'default', actorA), { content: 'a team deploy rule' })).id;
    seedTeamConflicts(4, 'default', [conflictOf(bPersonal, aTeam)]);
    const all = (await listConflicts(apiCtx(root), 'open', {}, { limit: 1000 })).conflicts;
    expect(all).toHaveLength(5);
    const hidden = all.find((c) => [c.memory_a_id, c.memory_b_id].includes(bPersonal))!.id;

    const ctxA = apiCtx(root, 'default', actorA);
    const seenByA = await walk((page) => listOpenConflicts(ctxA, page), 1);
    expect(seenByA.ids).not.toContain(hidden);
    expect(seenByA.ids).toHaveLength(4);
    expect(await getConflict(ctxA, hidden)).toBeNull();
    expect((await walk((page) => listOpenConflicts(apiCtx(root, 'default', actorB), page), 1)).ids).toContain(hidden);
  });

  it("keeps another tenant's conflicts off a tenant key's pages", async () => {
    seedTeamConflicts(2, 'other');
    expect((await listOpenConflicts(apiCtx(root, 'default', actorA))).conflicts).toHaveLength(0);
    expect((await listConflicts(apiCtx(root), 'open', { everyTenant: true })).conflicts).toHaveLength(2);
  });
});
