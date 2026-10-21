// Root-keyed conflicts forms tests call; production code goes through the store port or the At forms.

import { CLI_ACTOR } from '../../../src/base/scope/actor.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { replaceDetectedConflictsAt } from '../../../src/store/sqlite/conflicts.js';
import { onHandle, openStore } from '../../../src/store/sqlite/handles.js';
import type { MemoryConflict } from '../../../src/store/port/conflicts.js';
import type { KeysetPosition } from '../../../src/base/util/keyset.js';
import { MAX_LIST_LIMIT } from '../../../src/base/util/limits.js';
import type { DetectedConflict } from '../../../src/store/port/consolidation.js';
import { ALL_TENANTS, type TenantId } from '../../../src/base/util/tenant.js';

export function replaceDetectedConflicts(
  hippoRoot: string,
  detected: Array<DetectedConflict>,
  detectedAt?: string,
): void {
  onHandle(hippoRoot, (db) => replaceDetectedConflictsAt(db, { hippoRoot }, detected, detectedAt), openStore);
}

export function listMemoryConflicts(
  hippoRoot: string,
  status: string = 'open',
  tenantId: TenantId = ALL_TENANTS,
): MemoryConflict[] {
  const { conflicts } = sqliteSyncStore(hippoRoot);
  const out: MemoryConflict[] = [];
  let after: KeysetPosition | undefined;
  do {
    const page = conflicts.list({ tenantId, status, limit: MAX_LIST_LIMIT, after });
    out.push(...page.rows.map((row) => row.conflict));
    after = page.next ?? undefined;
  } while (after);
  return out;
}

export function resolveConflictKeeping(
  hippoRoot: string,
  tenantId: string,
  conflictId: number,
  keepId: string,
): boolean {
  const conflicts = sqliteSyncStore(hippoRoot).conflicts;
  const row = conflicts.get(tenantId, conflictId);
  if (!row) return false;
  const a = { id: row.conflict.memory_a_id, scope: row.a?.scope ?? null };
  const b = { id: row.conflict.memory_b_id, scope: row.b?.scope ?? null };
  const [keep, loser] = keepId === a.id ? [a, b] : [b, a];
  return conflicts.resolve(tenantId, {
    conflictId,
    keep,
    loser,
    fate: { kind: 'weaken' },
    actor: CLI_ACTOR,
    reason: '',
  });
}
