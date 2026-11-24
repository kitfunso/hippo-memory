import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import type { ObjectDescriptor } from './descriptor.js';
import { requireText } from './fields.js';
import { objectMirror, type ActedBy } from './lifecycle.js';
import {
  isObjectRefusal,
  type Incident,
  type IncidentStatus,
  type ObjectRefusal,
} from '../../base/records/object-types.js';
import type {
  IncidentOpen,
  IncidentOpenRefusal,
  IncidentResolve,
  Objects,
} from '../../base/ports/store.js';

export type { Incident, IncidentStatus } from '../../base/records/object-types.js';

export const VALID_INCIDENT_STATES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'open',
  'resolved',
  'closed',
]);

export interface SaveIncidentOptions {
  incidentText: string;
  context?: string;
  linkedMemoryIds?: string[];
  extraTags?: string[];
}

export const INCIDENT: ObjectDescriptor<'incident'> = {
  kind: 'incident',
  label: 'incident',
  plural: 'incidents',
  states: VALID_INCIDENT_STATES,
  closableFrom: ['open', 'resolved'],
  closeRefusal: 'already closed',
};

interface IncidentOpenOptions {
  readonly baseHalfLifeDays: number;
  readonly tenantId: string;
  readonly opts: SaveIncidentOptions;
  readonly actor: string;
  readonly now: Date;
}

function incidentOpen({
  baseHalfLifeDays,
  tenantId,
  opts,
  actor,
  now,
}: IncidentOpenOptions): IncidentOpen {
  assertTenantId('openIncident', tenantId);
  const incidentText = requireText(opts.incidentText, MAX_SHORT_FIELD_LEN, 'incidentText');
  const at = now.toISOString();
  const content = opts.context ? `${incidentText}\n\nContext: ${opts.context}` : incidentText;
  const mirror = objectMirror({
    baseHalfLifeDays,
    tenantId,
    source: 'incident',
    text: { content, tags: opts.extraTags ?? [] },
    now,
  });
  const fields = {
    incidentText,
    context: opts.context ?? undefined,
    linkedMemoryIds: opts.linkedMemoryIds ?? [],
  };
  return { mirror, fields, actor, at };
}

function opened(tenantId: string, written: Incident | IncidentOpenRefusal): Incident {
  if (!('refused' in written)) return written;
  if (written.refused === 'unlinked') {
    throw new NotFoundError(`linked memory ${written.memoryId} not found for tenant ${tenantId}`);
  }
  throw new Error('failed to reload saved incident row');
}

export interface OpenIncidentOptions {
  readonly baseHalfLifeDays: number;
  readonly tenantId: string;
  readonly opts: SaveIncidentOptions;
  readonly by: ActedBy;
}

/** Opens an incident with its mirror memory (content "<text>
 *
 * Context: <context>" when context is given) in one write; a linked memory outside the tenant
 * refuses the whole write. */
export async function openIncident(
  objects: Objects,
  { baseHalfLifeDays, tenantId, opts, by }: OpenIncidentOptions,
): Promise<Incident> {
  const open = incidentOpen({ baseHalfLifeDays, tenantId, opts, actor: by.actor, now: by.now });
  return opened(tenantId, await objects.saveObject(tenantId, 'incident', open));
}

function resolving(
  tenantId: string,
  resolutionText: string,
  { actor, now }: ActedBy,
): IncidentResolve {
  assertTenantId('resolveOpenIncident', tenantId);
  const text = requireText(resolutionText, MAX_SHORT_FIELD_LEN, 'resolutionText');
  return { text, actor, at: now.toISOString() };
}

function resolved(tenantId: string, id: number, written: Incident | ObjectRefusal): Incident {
  if (!isObjectRefusal(written)) return written;
  if (written.refused === 'missing') {
    throw new NotFoundError(`incident ${id} not found for tenant ${tenantId}`);
  }
  if (written.refused !== 'status') {
    throw new NotFoundError(`incident ${id} not found after UPDATE`);
  }
  throw new ConflictError(
    `incident ${id} is not open (status='${written.status}'); only open incidents can be resolved.`,
  );
}

export interface ResolveOpenIncidentOptions {
  readonly tenantId: string;
  readonly id: number;
  readonly resolutionText: string;
  readonly by: ActedBy;
}

/** Moves an open incident to resolved and keeps it on record; a missing incident and one that is
 * not open are told apart. */
export async function resolveOpenIncident(
  objects: Objects,
  { tenantId, id, resolutionText, by }: ResolveOpenIncidentOptions,
): Promise<Incident> {
  return resolved(
    tenantId,
    id,
    await objects.closeObject(tenantId, 'incident', id, resolving(tenantId, resolutionText, by)),
  );
}
