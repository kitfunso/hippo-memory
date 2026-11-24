import type { DashboardReads } from '../../base/ports/store/dashboard-reads.js';

const COALESCE_MS = 10_000;
const TTL_MS = 5 * 60_000;

/** What one dashboard read is dated by: its id, and the instant strengths are judged at. */
export interface Stamp {
  readonly id: number;
  readonly tenantId: string;
  readonly nowMs: number;
}

interface HeldStamp extends Stamp {
  readonly dataVersion: number | null;
  readonly issuedAtMs: number;
}

export interface SnapshotClock {
  at(tenantId: string, fresh?: boolean): Promise<Stamp>;
  invalidate(): void;
  currentId(): number;
}

function stillServes(
  held: HeldStamp,
  tenantId: string,
  dataVersion: number | null,
  wallMs: number,
): boolean {
  const age = wallMs - held.issuedAtMs;
  return (
    held.tenantId === tenantId &&
    (held.dataVersion !== null || dataVersion === null) &&
    age < TTL_MS &&
    (held.dataVersion === dataVersion || age < COALESCE_MS)
  );
}

/** Stamps over the store's commit signal; `now` dates the strengths, `cacheClock` ages the
 * stamp. */
export function createSnapshotClock(
  reads: Pick<DashboardReads, 'commitCount'>,
  now: () => number,
  cacheClock: () => number = Date.now,
): SnapshotClock {
  let lastId = Date.now();
  let held: HeldStamp | null = null;
  return {
    async at(tenantId, fresh = false) {
      const nowMs = now();
      const wallMs = cacheClock();
      const dataVersion = await reads.commitCount();
      if (held !== null && !fresh && stillServes(held, tenantId, dataVersion, wallMs)) return held;
      lastId = Math.max(lastId + 1, Date.now());
      held = { id: lastId, tenantId, nowMs, dataVersion, issuedAtMs: wallMs };
      return held;
    },
    invalidate() {
      held = null;
    },
    currentId: () => lastId,
  };
}
