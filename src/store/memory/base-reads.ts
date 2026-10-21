// The in-memory base reads beyond recall search: fresh raw rows, the continuity block and the planning evidence.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import type { ContinuityBlock } from '../port.js';
import type { ClassResolution, ContinuityKey, PlanningFallacyEvidence } from '../port/types.js';
import { latestHandoffIn } from './handoffs.js';
import { baserateIn } from './predictions.js';
import { byBytes, rowsByIds } from './rows.js';
import { listEventsIn, loadSnapshotIn } from './snapshots.js';
import type { MemoryTables } from './tables.js';

const MAX_FRESH_RAW = 200;

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
  fresh.sort((a, b) => byBytes(b.created, a.created) || byBytes(a.content, b.content) || byBytes(a.id, b.id));
  return structuredClone(fresh.slice(0, Math.min(count, MAX_FRESH_RAW)));
}

export function continuityIn(
  t: MemoryTables,
  tenantId: string,
  eventLimit: number,
  key: ContinuityKey | null,
): ContinuityBlock {
  const activeSnapshot = loadSnapshotIn(t, tenantId, key);
  const sessionId = activeSnapshot?.session_id ?? undefined;
  return {
    activeSnapshot,
    sessionHandoff: sessionId ? latestHandoffIn(t, tenantId, sessionId, {}, key) : null,
    recentSessionEvents: sessionId ? listEventsIn(t, tenantId, { sessionId, limit: eventLimit }) : [],
  };
}

// Copied from hippo.db's adapter, where it is not exported: lower-cased token overlap, a unique best of at least one
// wins, a tie at the top resolves no class.
function resolveClass(t: MemoryTables, tenantId: string, queryTokens: readonly string[]): ClassResolution {
  if (queryTokens.length === 0) return { classTag: null, tiebreak: false };
  const tags = new Set([...t.predictions.values()].flatMap((p) => (p.tenantId === tenantId ? [p.classTag] : [])));
  const query = new Set(queryTokens);
  let best = 0;
  let second = 0;
  let bestClass: string | null = null;
  for (const tag of tags) {
    const parts = tag
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((part) => part.length >= 3);
    const score = parts.filter((part) => query.has(part)).length;
    if (score > best) {
      second = best;
      best = score;
      bestClass = tag;
    } else if ((score === best && score > 0) || score > second) {
      second = score;
    }
  }
  if (best < 1) return { classTag: null, tiebreak: false };
  if (best === second) return { classTag: null, tiebreak: true };
  return { classTag: bestClass, tiebreak: false };
}

export function planningEvidenceIn(
  t: MemoryTables,
  tenantId: string,
  tokens: readonly string[],
): PlanningFallacyEvidence {
  const resolution = resolveClass(t, tenantId, tokens);
  const { classTag } = resolution;
  return { ...resolution, baserate: classTag ? baserateIn(t, tenantId, classTag) : null };
}
