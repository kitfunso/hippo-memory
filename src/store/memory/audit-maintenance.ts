// The in-memory AuditMaintenance group: object-backed ids, the automatic deletes, the audit prune and quality repair.
import { calculateStrength, canAutoDelete, type LossAversion, type MemoryEntry } from '../../base/memory/memory.js';
import { isRepairCandidate } from '../../base/memory/memory-audit.js';
import { repairIssues } from '../rules/repair-issues.js';
import type {
  AuditMaintenance,
  AuditPrune,
  QualityRepairIssue,
  QualityRepairResult,
  RepairProtection,
} from '../port/audit.js';
import { setAside } from './dormant.js';
import { byBytes, oldestFirst } from '../rules/order.js';
import { appendAudit, tenantKey } from './rows.js';
import { markParentDirty, stage, type Tx } from './staged.js';
import type { MemoryTables } from './tables.js';

const AUTO_REPAIR_META_KEY = 'quality_repair_auto';

/** The ids among `ids` a prediction or typed object names, in any tenant. */
function backedAmong(t: MemoryTables, ids: readonly string[]): Set<string> {
  const wanted = new Set(ids);
  const named = [...t.predictions.values(), ...Object.values(t.objects).flatMap((table) => [...table.values()])];
  return new Set(named.flatMap((row) => (row.memoryId !== null && wanted.has(row.memoryId) ? [row.memoryId] : [])));
}

/** hippo.db's automatic-delete guard: a pinned, raw, kept or object-backing row stays. */
function deletesAutomatically(t: MemoryTables, tx: Tx, id: string, actor: string, reason?: string): MemoryEntry | null {
  const row = tx.rows.get(id);
  if (!row || !canAutoDelete(row) || backedAmong(t, [id]).has(id)) return null;
  tx.rows.delete(id);
  if (reason !== undefined) {
    const metadata = reason ? { reason } : undefined;
    tx.audit.push({ tenantId: row.tenantId, actor, op: 'forget', targetId: id, metadata });
  }
  if (row.dagParentId) markParentDirty(tx, row.dagParentId, row.tenantId, actor);
  return row;
}

function pruneIn(t: MemoryTables, { tenantId, cutoff, actor, olderThanDays, dryRun }: AuditPrune): number {
  const before = (ts: string): boolean => byBytes(ts, cutoff) < 0;
  const count = t.audit.filter((e) => e.tenantId === tenantId && before(e.ts)).length;
  if (dryRun) return count;
  const kept = t.audit.filter((e) => e.tenantId !== tenantId || !before(e.ts));
  t.audit.splice(0, t.audit.length, ...kept);
  const metadata = { cutoff, count, dryRun: false, olderThanDays };
  appendAudit(t, [{ tenantId, actor, op: 'audit_prune', metadata }]);
  return count;
}

/** Each parent the rows name: the live row, else its dormant snapshot. */
function parentsOf(t: MemoryTables, tenantId: string, entries: readonly MemoryEntry[]): Map<string, MemoryEntry> {
  const parents = new Map<string, MemoryEntry>();
  for (const id of new Set(entries.flatMap((e) => e.parents))) {
    const live = t.entries.get(id);
    const parent = live?.tenantId === tenantId ? live : t.dormant.get(tenantKey(tenantId, id))?.entry;
    if (parent) parents.set(id, parent);
  }
  return parents;
}

/** The tenant's issues in store order, each defect kept when `protect` names its row. */
function planIssues(t: MemoryTables, tenantId: string, protect: RepairProtection) {
  const entries = [...t.entries.values()].filter((e) => e.tenantId === tenantId && isRepairCandidate(e));
  entries.sort(oldestFirst);
  const parents = parentsOf(t, tenantId, entries);
  const backing = backedAmong(
    t,
    entries.map((e) => e.id),
  );
  return { total: entries.length, issues: repairIssues(entries, parents, backing, protect) };
}

/** Moves each set-aside row to dormant storage in one staged write, behind the automatic-delete guard. */
function applyIssues(t: MemoryTables, issues: readonly QualityRepairIssue[], rules: LossAversion) {
  const actor = 'quality-repair';
  const now = new Date();
  const appliedIds: string[] = [];
  const warnings: string[] = [];
  const moved = stage(t, actor, (tx) =>
    issues.flatMap((issue) => {
      if (issue.disposition !== 'set-aside') return [];
      const row = deletesAutomatically(t, tx, issue.id, actor);
      if (!row) {
        warnings.push(`Kept ${issue.id}: the store's delete guard protects it.`);
        return [];
      }
      const metadata = { reason: issue.reason, backup: null };
      tx.audit.push({ tenantId: row.tenantId, actor, op: 'quality_repair', targetId: row.id, metadata });
      appliedIds.push(row.id);
      return [row];
    }),
  );
  const dormantAt = now.toISOString();
  for (const entry of moved) {
    setAside(t, { entry, strength: calculateStrength(entry, now, rules), reason: 'quality-repair', dormantAt });
  }
  return { appliedIds, warnings };
}

// No hippo.db file, so no schema version and no backup file; a moved row comes back through dormant restore.
function repairIn(t: MemoryTables, tenantId: string, apply: boolean, protect: RepairProtection, rules: LossAversion) {
  const { total, issues } = planIssues(t, tenantId, protect);
  const applied = apply ? applyIssues(t, issues, rules) : { appliedIds: [], warnings: [] };
  const result: QualityRepairResult = {
    root: '',
    schema: 0,
    supported: true,
    blockers: [],
    total,
    issues,
    appliedIds: applied.appliedIds,
    backup: null,
    warnings: applied.warnings,
  };
  return result;
}

export function memoryAuditMaintenance(t: MemoryTables, rules: LossAversion): AuditMaintenance {
  return {
    objectBackedAmong: async (ids) => backedAmong(t, ids),
    async deleteAutomatically(removals, actor) {
      if (removals.length === 0) return [];
      return stage(t, actor, (tx) =>
        removals.flatMap(({ id, reason }) => (deletesAutomatically(t, tx, id, actor, reason) ? [id] : [])),
      );
    },
    pruneAuditRows: async (prune) => pruneIn(t, prune),
    repairQuality: async (tenantId, apply, protect) => repairIn(t, tenantId, apply, protect, rules),
    async repairQualityOnce(tenantId, protect) {
      if (t.meta.get(AUTO_REPAIR_META_KEY) === '1') return null;
      const result = repairIn(t, tenantId, true, protect, rules);
      t.meta.set(AUTO_REPAIR_META_KEY, '1');
      return result;
    },
  };
}
