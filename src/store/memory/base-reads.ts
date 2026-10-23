// The in-memory base reads beyond recall search: fresh raw rows, the continuity block and the planning evidence.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import type { ContinuityBlock } from '../port.js';
import type { ContinuityKey, PlanningFallacyEvidence } from '../port/types.js';
import { resolveClass } from '../rules/class-resolution.js';
import { latestHandoffIn } from './handoffs.js';
import { baserateIn } from './predictions.js';
import { freshRawOrder } from '../rules/order.js';
import { MAX_FRESH_RAW } from '../rules/windows.js';
import { rowsByIds } from './rows.js';
import { listEventsIn, loadSnapshotIn } from './snapshots.js';
import type { MemoryTables } from './tables.js';

export function entriesByIdsIn(t: MemoryTables, ids: readonly string[], tenantId: TenantId): MemoryEntry[] {
  return rowsByIds(t.entries.values(), ids, (tenant) => tenantId === ALL_TENANTS || tenant === tenantId);
}

/** Unsuperseded raw rows, newest first; content before id breaks a tie, since ids are random. */
export function freshRawIn(
  t: MemoryTables,
  count: number,
  tenantId: string,
  sessionId: string | undefined,
  origins: readonly string[] | null,
): MemoryEntry[] {
  if (count <= 0) return [];
  const fresh = [...t.entries.values()].filter((e) => {
    const origin = e.originProject ?? null;
    return (
      e.kind === 'raw' &&
      e.supersededBy === null &&
      e.tenantId === tenantId &&
      (!sessionId || e.sourceSessionId === sessionId) &&
      (origins === null || (origin !== null && (origin === '' || origins.includes(origin))))
    );
  });
  fresh.sort(freshRawOrder);
  return structuredClone(fresh.slice(0, Math.min(count, MAX_FRESH_RAW)));
}

export function continuityIn(
  t: MemoryTables,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  const activeSnapshot = loadSnapshotIn(t, tenantId, key);
  const sessionId = activeSnapshot?.sessionId ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? latestHandoffIn(t, tenantId, sessionId, {}, key) : null,
    recentSessionEvents: sessionId ? listEventsIn(t, tenantId, { sessionId, limit: eventLimit }) : [],
  };
}

export function planningEvidenceIn(
  t: MemoryTables,
  tenantId: string,
  tokens: readonly string[],
): PlanningFallacyEvidence {
  const tags = new Set([...t.predictions.values()].flatMap((p) => (p.tenantId === tenantId ? [p.classTag] : [])));
  const resolution = resolveClass(tags, tokens);
  const { classTag } = resolution;
  return { ...resolution, baserate: classTag ? baserateIn(t, tenantId, classTag) : null };
}
