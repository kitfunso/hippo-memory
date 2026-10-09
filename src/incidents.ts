/**
 * Incident first-class object.
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

import { BadRequestError, ConflictError, NotFoundError } from './api-errors.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import { withWriteScope } from './db/busy.js';
import { writeEntry } from './store/entry-writes.js';
import { onHandle } from './store/open.js';
import { assertTenantId } from './tenant.js';
import { appendAuditEvent } from './audit.js';
import type { KeysetPosition } from './keyset.js';
import type { ObjectDescriptor } from './objects/descriptor.js';
import { assertObjectStatus, closeObjectOn, loadObjectByIdOn, loadObjectsOn, objectMirrorMemory } from './objects/lifecycle.js';

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
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
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
    // SAFETY: JSON.parse output is arbitrary; narrowed by Array.isArray plus
    // the per-element string check below before use as string[].
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
    return [];
  } catch {
    // A malformed list column reads as empty instead of failing the incident read.
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
    // SAFETY: status is DB-constrained to VALID_INCIDENT_STATES; this module
    // is the only writer and always inserts one of those literal strings.
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

// No save entry: an incident checks its linked memories inside the write, so it keeps its own save.
const INCIDENT: ObjectDescriptor<Incident, IncidentRow> = {
  table: 'incidents',
  cols: INCIDENT_COLS,
  label: 'incident',
  plural: 'incidents',
  fn: { get: 'loadIncidentById', close: 'closeIncident', list: 'loadIncidents' },
  states: VALID_INCIDENT_STATES,
  closableFrom: ['open', 'resolved'],
  closeRefusal: 'already closed',
  ops: { close: 'incident_close' },
  idKey: 'incident_id',
  listFilters: {},
  rowTo: rowToIncident,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Validate every linked receipt BEFORE inserting the row. Each must be a
// memory in the SAME tenant; a cross-tenant or nonexistent id rejects the
// whole write rather than recording an unverifiable receipt.
function validateLinkedMemoryIds(db: DatabaseSyncLike, tenantId: string, linkInput: string[]): string[] {
  const validated: string[] = [];
  for (const linkId of linkInput) {
    // SAFETY: row shape matches the single `id` column named in the SELECT above.
    const exists = db.prepare(
      `SELECT id FROM memories WHERE id = ? AND tenant_id = ?`,
    ).get(linkId, tenantId) as { id: string } | undefined;
    if (!exists) {
      throw new NotFoundError(
        `saveIncident: linked memory ${linkId} not found for tenant ${tenantId}`,
      );
    }
    validated.push(linkId);
  }
  return validated;
}

/** The afterWrite body: link validation, INSERT, reload, open audit, all in one SAVEPOINT. */
function writeIncidentRow(
  db: DatabaseSyncLike,
  memoryId: string,
  tenantId: string,
  opts: SaveIncidentOpts,
  actor: string,
  now: string,
): IncidentRow {
  const validated = validateLinkedMemoryIds(db, tenantId, opts.linkedMemoryIds ?? []);

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

  // SAFETY: row's shape matches the columns named in INCIDENT_COLS above.
  const row = db.prepare(`SELECT ${INCIDENT_COLS} FROM incidents WHERE id = ?`)
    .get(incidentId) as IncidentRow | undefined;
  if (!row) throw new Error('saveIncident: failed to reload saved incident row');

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
  return row;
}

/**
 * Create an incident. Writes the memory mirror + the incidents row atomically
 * inside writeEntry's SAVEPOINT 'write_entry'.
 *
 * The memory mirror: tags ['incident', ...extraTags], source 'incident',
 * confidence 'verified', the half-life objectHalfLifeDays picks, content =
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
  if (!opts.incidentText) throw new BadRequestError('saveIncident: incidentText is required');

  const now = new Date().toISOString();
  const content = opts.context
    ? `${opts.incidentText}\n\nContext: ${opts.context}`
    : opts.incidentText;
  const mem = objectMirrorMemory(hippoRoot, tenantId, 'incident', content, opts.extraTags ?? []);

  // Populated inside afterWrite so the linked-id validation, the INSERT, and the
  // memory write all share one SAVEPOINT.
  let savedRow: IncidentRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      savedRow = writeIncidentRow(db, memoryId, tenantId, opts, actor, now);
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
    throw new BadRequestError('resolveIncident: resolutionText is required (non-empty)');
  }
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => withWriteScope(db, 'resolve_incident', () => {
    const updateResult = db.prepare(`
      UPDATE incidents
      SET status = 'resolved', resolution_text = ?, resolved_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'open'
    `).run(resolutionText, now, id, tenantId);

    if (updateResult.changes === 0) {
      const existing = db.prepare(`SELECT status FROM incidents WHERE id = ? AND tenant_id = ?`)
        .get<{ status: string } | undefined>(id, tenantId);
      if (!existing) {
        throw new NotFoundError(`resolveIncident: incident ${id} not found for tenant ${tenantId}`);
      }
      throw new ConflictError(
        `resolveIncident: incident ${id} is not open (status='${existing.status}'); only open incidents can be resolved.`,
      );
    }

    const resolved = loadObjectByIdOn(db, INCIDENT, tenantId, id);
    if (!resolved) throw new NotFoundError(`resolveIncident: incident ${id} not found after UPDATE`);

    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'incident_resolve',
      targetId: String(id),
      metadata: { incident_id: id },
    });
    return resolved;
  }));
}

/**
 * Close (retire) an incident from open or resolved (open|resolved -> closed).
 * Updates closed_at only; the memory mirror is not mutated.
 */
export function closeIncident(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Incident {
  assertTenantId(INCIDENT.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => closeObjectOn(db, INCIDENT, tenantId, id, { actor, now }));
}

export function loadIncidentById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Incident | null {
  assertTenantId(INCIDENT.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, INCIDENT, tenantId, id));
}

export function loadIncidents(
  hippoRoot: string,
  tenantId: string,
  opts: ListIncidentsOpts = {},
): Incident[] {
  assertTenantId(INCIDENT.fn.list, tenantId);
  assertObjectStatus(INCIDENT, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, INCIDENT, tenantId, opts));
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
    // SAFETY: row shape matches the single `id` column named in the SELECT above.
    const row = db.prepare(
      `SELECT id FROM incidents WHERE memory_id = ? AND tenant_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
    ).get(memoryId, tenantId) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    closeHippoDb(db);
  }
}
