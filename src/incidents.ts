/**
 * E2 incident first-class object (docs/plans/2026-05-29-e2-incident-object.md).
 *
 * An incident is a postmortem capsule: a recorded operational event with a
 * lifecycle and optional linked receipts (the memories that are its evidence).
 * The `incidents` table is the source of truth: an incident stays `open`
 * regardless of memory decay. A memory row still mirrors the incident for
 * recall surfaces but is NOT canonical — memory_id is NULLABLE with ON DELETE
 * SET NULL so forget/consolidate/archive gracefully orphans the incident row.
 *
 * Lifecycle: open -> resolved (a resolution was recorded; the incident stays on
 * record with resolution_text + resolved_at) or open|resolved -> closed
 * (retired with closed_at). This is NOT decision's supersede: there is no
 * superseded_by self-FK, no supersede CAS, and no supersede trigger.
 *
 * Tenant scoping: every helper requires tenantId. BEFORE INSERT/UPDATE triggers
 * enforce incidents.tenant_id == the referenced memory's tenant_id. Mirrors the
 * v30 decisions pattern (src/decisions.ts).
 *
 * Dual-write atomicity: `saveIncident` writes the memory + incidents row inside
 * writeEntry's SAVEPOINT 'write_entry' (store.ts) via the afterWrite hook, so a
 * failure in any step rolls all of them back. Pattern matches saveDecision.
 *
 * linked_memory_ids ("linked receipts"): a JSON-encoded array of memory ids on
 * the row, default `[]`. On save, every id must exist in the SAME tenant; a
 * cross-tenant or nonexistent id is rejected (throw) before the insert.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, INCIDENT_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type IncidentStatus = 'open' | 'resolved' | 'closed';

export const VALID_INCIDENT_STATES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'open',
  'resolved',
  'closed',
]);

export interface Incident {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion (forget / consolidate /
   *  archive) proceed without breaking the incident row. */
  memoryId: string | null;
  tenantId: string;
  incidentText: string;
  context: string | null;
  status: IncidentStatus;
  /** Set only when status === 'resolved'. */
  resolutionText: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Linked receipts: memory ids that are this incident's evidence. */
  linkedMemoryIds: string[];
  createdAt: string;
}

export interface SaveIncidentOpts {
  incidentText: string;
  context?: string;
  /** Memory ids (linked receipts) that are this incident's evidence. Each must
   *  exist in the same tenant; cross-tenant/nonexistent ids are rejected. */
  linkedMemoryIds?: string[];
  /** Extra memory tags merged after ['incident'] (the CLI passes path-context
   *  tags; HTTP/SDK pass none). */
  extraTags?: string[];
}

export interface ListIncidentsOpts {
  status?: IncidentStatus;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface IncidentRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  incident_text: string;
  context: string | null;
  status: string;
  resolution_text: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  linked_memory_ids: string;
  created_at: string;
}

function parseLinkedMemoryIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    incidentText: row.incident_text,
    context: row.context,
    status: row.status as IncidentStatus,
    resolutionText: row.resolution_text,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    linkedMemoryIds: parseLinkedMemoryIds(row.linked_memory_ids),
    createdAt: row.created_at,
  };
}

const INCIDENT_COLS = `
  id, memory_id, tenant_id, incident_text, context, status,
  resolution_text, resolved_at, closed_at, linked_memory_ids, created_at
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an incident. Writes the memory mirror + the incidents row atomically
 * inside writeEntry's SAVEPOINT 'write_entry'.
 *
 * The memory mirror: tags ['incident', ...extraTags], source 'incident',
 * confidence 'verified', half_life INCIDENT_HALF_LIFE_DAYS, content =
 * "<text>\n\nContext: <context>" when context is given.
 *
 * linked_memory_ids are validated BEFORE insert: each must exist in the SAME
 * tenant. A cross-tenant or nonexistent id throws and rolls back the whole
 * write. The validated ids are stored as JSON.stringify(validated).
 */
export function saveIncident(
  hippoRoot: string,
  tenantId: string,
  opts: SaveIncidentOpts,
  actor: string = 'cli',
): Incident {
  assertTenantId('saveIncident', tenantId);
  if (!opts.incidentText) throw new Error('saveIncident: incidentText is required');

  const now = new Date().toISOString();
  const content = opts.context
    ? `${opts.incidentText}\n\nContext: ${opts.context}`
    : opts.incidentText;
  const tags = ['incident', ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'incident',
    tenantId,
  });
  mem.half_life_days = INCIDENT_HALF_LIFE_DAYS;

  const linkInput = opts.linkedMemoryIds ?? [];

  // Populated inside afterWrite so the linked-id validation, the INSERT, and the
  // memory write all share one SAVEPOINT.
  let savedRow: IncidentRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Validate every linked receipt BEFORE inserting the row. Each must be a
      // memory in the SAME tenant; a cross-tenant or nonexistent id rejects the
      // whole write rather than recording an unverifiable receipt.
      const validated: string[] = [];
      for (const linkId of linkInput) {
        const exists = db.prepare(
          `SELECT id FROM memories WHERE id = ? AND tenant_id = ?`,
        ).get(linkId, tenantId) as { id: string } | undefined;
        if (!exists) {
          throw new Error(
            `saveIncident: linked memory ${linkId} not found for tenant ${tenantId}`,
          );
        }
        validated.push(linkId);
      }

      const result = db.prepare(`
        INSERT INTO incidents(
          memory_id, tenant_id, incident_text, context,
          status, resolution_text, resolved_at, closed_at, linked_memory_ids, created_at
        ) VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?)
      `).run(
        memoryId,
        tenantId,
        opts.incidentText,
        opts.context ?? null,
        JSON.stringify(validated),
        now,
      );
      const incidentId = Number(result.lastInsertRowid ?? 0);

      const row = db.prepare(`SELECT ${INCIDENT_COLS} FROM incidents WHERE id = ?`)
        .get(incidentId) as IncidentRow | undefined;
      if (!row) throw new Error('saveIncident: failed to reload saved incident row');
      savedRow = row;

      // GDPR-light metadata: id + flag only, no incident_text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'incident_open',
        targetId: String(incidentId),
        metadata: {
          incident_id: incidentId,
          has_context: opts.context !== undefined && opts.context !== null && opts.context !== '',
          linked_memory_count: validated.length,
        },
      });
    },
  });

  if (!savedRow) {
    // Unreachable unless afterWrite threw first; defensive.
    throw new Error('saveIncident: afterWrite did not populate the row');
  }
  return rowToIncident(savedRow);
}

/**
 * Resolve an open incident (open -> resolved). Records resolution_text +
 * resolved_at; the incident stays on record. CAS guard: WHERE status='open';
 * 0 changes distinguishes not-found from not-open so callers surface the right
 * error. Emits incident_resolve.
 */
export function resolveIncident(
  hippoRoot: string,
  tenantId: string,
  id: number,
  resolutionText: string,
  actor: string = 'cli',
): Incident {
  assertTenantId('resolveIncident', tenantId);
  if (!resolutionText || !resolutionText.trim()) {
    throw new Error('resolveIncident: resolutionText is required (non-empty)');
  }
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE incidents
        SET status = 'resolved', resolution_text = ?, resolved_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'open'
      `).run(resolutionText, now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM incidents WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`resolveIncident: incident ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `resolveIncident: incident ${id} is not open (status='${existing.status}'); only open incidents can be resolved.`,
        );
      }

      const row = db.prepare(`SELECT ${INCIDENT_COLS} FROM incidents WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as IncidentRow | undefined;
      if (!row) throw new Error(`resolveIncident: incident ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'incident_resolve',
        targetId: String(id),
        metadata: { incident_id: id },
      });

      db.exec('COMMIT');
      return rowToIncident(row);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Close (retire) an incident from open or resolved (open|resolved -> closed).
 * Updates closed_at only; the memory mirror is not mutated. CAS guard: WHERE
 * status IN ('open','resolved'); 0 changes distinguishes not-found from
 * wrong-state. Emits incident_close.
 */
export function closeIncident(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Incident {
  assertTenantId('closeIncident', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE incidents
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status IN ('open', 'resolved')
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM incidents WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeIncident: incident ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeIncident: incident ${id} is already closed (status='${existing.status}'); only open or resolved incidents can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${INCIDENT_COLS} FROM incidents WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as IncidentRow | undefined;
      if (!row) throw new Error(`closeIncident: incident ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'incident_close',
        targetId: String(id),
        metadata: { incident_id: id },
      });

      db.exec('COMMIT');
      return rowToIncident(row);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function loadIncidentById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Incident | null {
  assertTenantId('loadIncidentById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${INCIDENT_COLS} FROM incidents WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as IncidentRow | undefined;
    return row ? rowToIncident(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadIncidents(
  hippoRoot: string,
  tenantId: string,
  opts: ListIncidentsOpts = {},
): Incident[] {
  assertTenantId('loadIncidents', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    let rows: IncidentRow[];
    if (opts.status) {
      if (!VALID_INCIDENT_STATES.has(opts.status)) {
        throw new Error(
          `loadIncidents: status must be one of ${Array.from(VALID_INCIDENT_STATES).join('|')}; got ${opts.status}`,
        );
      }
      rows = db.prepare(`
        SELECT ${INCIDENT_COLS} FROM incidents
        WHERE tenant_id = ? AND status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.status, limit) as IncidentRow[];
    } else {
      rows = db.prepare(`
        SELECT ${INCIDENT_COLS} FROM incidents
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, limit) as IncidentRow[];
    }
    return rows.map(rowToIncident);
  } finally {
    closeHippoDb(db);
  }
}

export function loadOpenIncidents(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Incident[] {
  return loadIncidents(hippoRoot, tenantId, { status: 'open', limit: opts.limit });
}

/**
 * Resolve a memory id to the table id of the OPEN incident backed by that
 * memory, or null when the memory has no open incident row. Extracted so a
 * memory-id-based lookup is unit-testable at the store layer (mirror of
 * resolveActiveDecisionIdByMemory).
 */
export function resolveActiveIncidentIdByMemory(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): number | null {
  assertTenantId('resolveActiveIncidentIdByMemory', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(
      `SELECT id FROM incidents WHERE memory_id = ? AND tenant_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
    ).get(memoryId, tenantId) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    closeHippoDb(db);
  }
}
