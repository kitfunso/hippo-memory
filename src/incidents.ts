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
 * Dual-write atomicity: `saveIncident` writes the memory + incidents row in the
 * `objects` store group's one transaction, so a failure in any step rolls all of
 * them back.
 *
 * linked_memory_ids ("linked receipts"): a JSON-encoded array of memory ids on
 * the row, default `[]`. On save, every id must exist in the SAME tenant; a
 * cross-tenant or nonexistent id is rejected (throw) before the insert.
 */

import { BadRequestError, ConflictError, NotFoundError } from './api-errors.js';
import { assertTenantId } from './tenant.js';
import type { KeysetPosition } from './keyset.js';
import type { ObjectDescriptor } from './objects/descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, objectMirror } from './objects/lifecycle.js';
import type { Incident, IncidentStatus } from './store/object-types.js';
import { isObjectRefusal, type IncidentOpen, type IncidentOpenRefusal, type IncidentResolve, type ObjectRefusal, type Objects } from './store/port.js';
import { objectIdByMemory, sqliteObjects } from './store/sqlite/objects-group.js';

export type { Incident, IncidentStatus } from './store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const VALID_INCIDENT_STATES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'open',
  'resolved',
  'closed',
]);

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

// No draft: an incident is opened with linked memories and is never superseded, so it keeps its own save.
export const INCIDENT: ObjectDescriptor<'incident'> = {
  kind: 'incident',
  label: 'incident',
  plural: 'incidents',
  fn: { get: 'loadIncidentById', close: 'closeIncident', list: 'loadIncidents' },
  states: VALID_INCIDENT_STATES,
  closableFrom: ['open', 'resolved'],
  closeRefusal: 'already closed',
};

/** One open, checked before a store is asked; `hippoRoot` is read only for the configured half-life. */
function incidentOpen(hippoRoot: string, tenantId: string, opts: SaveIncidentOpts, actor: string): IncidentOpen {
  assertTenantId('saveIncident', tenantId);
  if (!opts.incidentText) throw new BadRequestError('saveIncident: incidentText is required');
  const at = new Date().toISOString();
  const content = opts.context
    ? `${opts.incidentText}\n\nContext: ${opts.context}`
    : opts.incidentText;
  const mirror = objectMirror(hippoRoot, tenantId, 'incident', { content, tags: opts.extraTags ?? [] });
  const fields = { incidentText: opts.incidentText, context: opts.context ?? undefined, linkedMemoryIds: opts.linkedMemoryIds ?? [] };
  return { mirror, fields, actor, at };
}

function opened(tenantId: string, written: Incident | IncidentOpenRefusal): Incident {
  if (!('refused' in written)) return written;
  // A linked id of another tenant reads as missing, so an unverifiable receipt is never recorded.
  if (written.refused === 'unlinked') throw new NotFoundError(`saveIncident: linked memory ${written.memoryId} not found for tenant ${tenantId}`);
  throw new Error('saveIncident: failed to reload saved incident row');
}

/** Opens an incident with its mirror memory (content "<text>\n\nContext: <context>" when context is given) in one write; a linked memory outside the tenant refuses the whole write. */
export function saveIncident(
  hippoRoot: string,
  tenantId: string,
  opts: SaveIncidentOpts,
  actor: string = 'cli',
): Incident {
  return opened(tenantId, sqliteObjects(hippoRoot).openIncident(tenantId, incidentOpen(hippoRoot, tenantId, opts, actor)));
}

/** `saveIncident` over a served store's group. */
export async function openIncident(objects: Objects, hippoRoot: string, tenantId: string, opts: SaveIncidentOpts, actor: string): Promise<Incident> {
  return opened(tenantId, await objects.openIncident(tenantId, incidentOpen(hippoRoot, tenantId, opts, actor)));
}

function resolving(tenantId: string, resolutionText: string, actor: string): IncidentResolve {
  assertTenantId('resolveIncident', tenantId);
  if (!resolutionText || !resolutionText.trim()) {
    throw new BadRequestError('resolveIncident: resolutionText is required (non-empty)');
  }
  return { text: resolutionText, actor, at: new Date().toISOString() };
}

function resolved(tenantId: string, id: number, written: Incident | ObjectRefusal): Incident {
  if (!isObjectRefusal(written)) return written;
  if (written.refused === 'missing') throw new NotFoundError(`resolveIncident: incident ${id} not found for tenant ${tenantId}`);
  if (written.refused !== 'status') throw new NotFoundError(`resolveIncident: incident ${id} not found after UPDATE`);
  throw new ConflictError(
    `resolveIncident: incident ${id} is not open (status='${written.status}'); only open incidents can be resolved.`,
  );
}

/** Moves an open incident to resolved and keeps it on record; a missing incident and one that is not open are told apart. */
export function resolveIncident(
  hippoRoot: string,
  tenantId: string,
  id: number,
  resolutionText: string,
  actor: string = 'cli',
): Incident {
  return resolved(tenantId, id, sqliteObjects(hippoRoot).resolveIncident(tenantId, id, resolving(tenantId, resolutionText, actor)));
}

/** `resolveIncident` over a served store's group. */
export async function resolveOpenIncident(objects: Objects, tenantId: string, id: number, resolutionText: string, actor: string): Promise<Incident> {
  return resolved(tenantId, id, await objects.resolveIncident(tenantId, id, resolving(tenantId, resolutionText, actor)));
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
  return closeObjectAt(hippoRoot, INCIDENT, tenantId, id, actor);
}

export function loadIncidentById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Incident | null {
  return objectByIdAt(hippoRoot, INCIDENT, tenantId, id);
}

export function loadIncidents(
  hippoRoot: string,
  tenantId: string,
  opts: ListIncidentsOpts = {},
): Incident[] {
  return listObjectsAt(hippoRoot, INCIDENT, tenantId, opts);
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
  return objectIdByMemory(hippoRoot, tenantId, 'incident', 'open', memoryId);
}
