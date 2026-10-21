// The nearest-row read a CLI asks of its server answers ids nearest first, and refuses what the caller's own recall
// would refuse: another tenant, a scope it may not read, and a shared store's read that names no project.
import { describe, expect, it } from 'vitest';
import { nearestMemoryIds } from '../../src/api/recall/nearest.js';
import { BadRequestError, ForbiddenError } from '../../src/base/errors/api-errors.js';
import { ScopeForbiddenError } from '../../src/base/scope/recall-scope.js';
import type { VectorCandidateSpec } from '../../src/store/port/vectors.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seedVectorRows } from '../_helpers/vector-rows.js';

// A restricted scope: a member reads it only with a grant.
const TEAM_B = 'team:private:b';

const ROWS = [
  { id: 'far', tenantId: 't1', vector: [0, 1, 0] },
  { id: 'near', tenantId: 't1', vector: [1, 0.1, 0] },
  { id: 'nearest', tenantId: 't1', vector: [1, 0, 0] },
  { id: 'other-tenant', tenantId: 't2', vector: [1, 0, 0] },
  { id: 'team-b', tenantId: 't1', scope: TEAM_B, vector: [1, 0, 0] },
];

function seeded(config: { sharedStore?: boolean } = {}): string {
  const root = makeRoot('nearest-ids', { config });
  seedVectorRows(root, ROWS);
  return root;
}

const spec = (extra: Partial<VectorCandidateSpec> = {}): VectorCandidateSpec => ({
  tenantId: 't1',
  scope: { mode: 'default-deny' },
  includeSuperseded: false,
  ...extra,
});

describe('nearestMemoryIds', () => {
  it("answers the caller's tenant's admitted ids, nearest first", async () => {
    const ctx = apiCtx(seeded(), 't1');
    expect(await nearestMemoryIds(ctx, [1, 0, 0], spec())).toEqual(['nearest', 'near', 'far']);
  });

  it('refuses a spec for another tenant', async () => {
    const ctx = apiCtx(seeded(), 't1');
    await expect(nearestMemoryIds(ctx, [1, 0, 0], spec({ tenantId: 't2' }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a scope the caller may not read, and answers one it may', async () => {
    const root = seeded();
    const member = apiCtx(root, 't1', { subject: 'api_key:k1', role: 'member' });
    const granted = apiCtx(root, 't1', { subject: 'api_key:k2', role: 'member', scopes: [TEAM_B] });
    const teamB = spec({ scope: { mode: 'exact', value: TEAM_B } });

    await expect(nearestMemoryIds(member, [1, 0, 0], teamB)).rejects.toBeInstanceOf(ScopeForbiddenError);
    await expect(
      nearestMemoryIds(member, [1, 0, 0], spec({ scope: { mode: 'default-deny', ownScope: TEAM_B } })),
    ).rejects.toBeInstanceOf(ScopeForbiddenError);
    expect(await nearestMemoryIds(granted, [1, 0, 0], teamB)).toEqual(['team-b']);
  });

  it('refuses a read on a shared store that names no project', async () => {
    const shared = apiCtx(seeded({ sharedStore: true }), 't1');
    await expect(nearestMemoryIds(shared, [1, 0, 0], spec())).rejects.toBeInstanceOf(BadRequestError);
  });
});
