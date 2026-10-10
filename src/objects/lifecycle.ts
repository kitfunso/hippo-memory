// Save, close, load-by-id and list for every typed object: the checks, the mirror memory and the error text, over the `objects` store group.
// Each flow is written twice over the same steps: `...At` answers at once on hippo.db for the CLI, and the other awaits a served store's group for the routes.
// The tenant, the fields and the list status are checked first, so a bad request fails before a store is asked.

import { BadRequestError, ConflictError, NotFoundError } from '../core/api-errors.js';
import { loadConfig } from '../core/config.js';
import { createMemory, Layer, type MemoryEntry } from '../core/memory.js';
import type { ObjectByKind, ObjectKind, SavableKind } from '../store/object-types.js';
import { isObjectRefusal, type ObjectClose, type ObjectListQuery, type ObjectRefusal, type Objects, type ObjectSave } from '../store/port.js';
import { sqliteObjects } from '../store/sqlite/objects-group.js';
import { assertTenantId } from '../store/tenant.js';
import type { ObjectDescriptor, ObjectDraft, ObjectListOpts, SavableDescriptor } from './descriptor.js';

/** An empty status or filter lists every row, as an absent one does. */
function listQuery<K extends ObjectKind>(d: ObjectDescriptor<K>, tenantId: string, opts: ObjectListOpts<K>): ObjectListQuery<K> {
  assertTenantId(d.fn.list, tenantId);
  if (opts.status && !d.states.has(opts.status)) {
    throw new BadRequestError(`${d.fn.list}: status must be one of ${Array.from(d.states).join('|')}; got ${opts.status}`);
  }
  return { status: opts.status || undefined, filter: opts.filter || undefined, limit: opts.limit ?? 100, after: opts.after };
}

/** Newest first. */
export function listObjectsAt<K extends ObjectKind>(hippoRoot: string, d: ObjectDescriptor<K>, tenantId: string, opts: ObjectListOpts<K>): ObjectByKind[K][] {
  return sqliteObjects(hippoRoot).listObjects(tenantId, d.kind, listQuery(d, tenantId, opts));
}

export async function listObjects<K extends ObjectKind>(
  objects: Objects,
  d: ObjectDescriptor<K>,
  tenantId: string,
  opts: ObjectListOpts<K>
): Promise<ObjectByKind[K][]> {
  return objects.listObjects(tenantId, d.kind, listQuery(d, tenantId, opts));
}

export function objectByIdAt<K extends ObjectKind>(hippoRoot: string, d: ObjectDescriptor<K>, tenantId: string, id: number): ObjectByKind[K] | null {
  assertTenantId(d.fn.get, tenantId);
  return sqliteObjects(hippoRoot).objectById(tenantId, d.kind, id);
}

export async function objectById<K extends ObjectKind>(
  objects: Objects,
  d: ObjectDescriptor<K>,
  tenantId: string,
  id: number
): Promise<ObjectByKind[K] | null> {
  assertTenantId(d.fn.get, tenantId);
  return objects.objectById(tenantId, d.kind, id);
}

function closing<K extends ObjectKind>(d: ObjectDescriptor<K>, tenantId: string, actor: string): ObjectClose<K> {
  assertTenantId(d.fn.close, tenantId);
  return { from: d.closableFrom, actor, at: new Date().toISOString() };
}

function closed<K extends ObjectKind>(d: ObjectDescriptor<K>, tenantId: string, id: number, written: ObjectByKind[K] | ObjectRefusal): ObjectByKind[K] {
  if (!isObjectRefusal(written)) return written;
  if (written.refused === 'missing') throw new NotFoundError(`${d.fn.close}: ${d.label} ${id} not found for tenant ${tenantId}`);
  if (written.refused !== 'status') throw new NotFoundError(`${d.fn.close}: ${d.label} ${id} not found after UPDATE`);
  const closable = d.closableFrom.join(' or ');
  throw new ConflictError(
    `${d.fn.close}: ${d.label} ${id} is ${d.closeRefusal ?? `not ${closable}`} (status='${written.status}'); only ${closable} ${d.plural} can be closed.`,
  );
}

/** Retires one object; its mirror memory stays as saved. */
export function closeObjectAt<K extends ObjectKind>(hippoRoot: string, d: ObjectDescriptor<K>, tenantId: string, id: number, actor: string): ObjectByKind[K] {
  const close = closing(d, tenantId, actor);
  return closed(d, tenantId, id, sqliteObjects(hippoRoot).closeObject(tenantId, d.kind, id, close));
}

export async function closeObject<K extends ObjectKind>(
  objects: Objects,
  d: ObjectDescriptor<K>,
  tenantId: string,
  id: number,
  actor: string
): Promise<ObjectByKind[K]> {
  const close = closing(d, tenantId, actor);
  return closed(d, tenantId, id, await objects.closeObject(tenantId, d.kind, id, close));
}

/** The memory a typed object writes beside its row, so recall finds the object. */
export function objectMirror(
  hippoRoot: string,
  tenantId: string,
  source: ObjectKind,
  text: { readonly content: string; readonly tags: readonly string[] }
): MemoryEntry {
  return createMemory(text.content, {
    tags: [source, ...text.tags],
    layer: Layer.Semantic,
    confidence: 'verified',
    source,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    tenantId,
  });
}

/** Where a save lands and who makes it; `hippoRoot` is read only for the configured half-life. */
export interface ObjectSaveSite {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly actor: string;
}

function objectSave<K extends SavableKind>(site: ObjectSaveSite, kind: K, draft: ObjectDraft<K>): ObjectSave<K> {
  const mirror = objectMirror(site.hippoRoot, site.tenantId, kind, draft);
  return { mirror, fields: draft.fields, supersedesId: draft.supersedesId, changeSummary: draft.changeSummary, actor: site.actor, at: draft.at };
}

function saved<K extends SavableKind, W>(
  d: SavableDescriptor<K, W>,
  tenantId: string,
  replaced: number | undefined,
  written: ObjectByKind[K] | ObjectRefusal
): ObjectByKind[K] {
  if (!isObjectRefusal(written)) return written;
  switch (written.refused) {
    case 'missing':
      throw new NotFoundError(`${d.fn.save}: ${d.label} ${replaced} to supersede not found for tenant ${tenantId}`);
    case 'status':
      throw new ConflictError(`${d.fn.save}: ${d.label} ${replaced} is not active (status='${written.status}'); only active ${d.plural} can be superseded.`);
    case 'raced':
      throw new ConflictError(`${d.fn.save}: ${d.label} ${replaced} could not be superseded (no longer active or self-reference).`);
    case 'vanished':
      throw new Error(`${d.fn.save}: failed to reload saved ${d.label} row`);
  }
}

/** Creates an object, or the version that replaces the one its options name, with its mirror memory in one write. */
export function saveObjectAt<K extends SavableKind, W>(d: SavableDescriptor<K, W>, site: ObjectSaveSite, opts: W): ObjectByKind[K] {
  assertTenantId(d.fn.save, site.tenantId);
  const draft = d.draft(opts);
  return saved(d, site.tenantId, draft.supersedesId, sqliteObjects(site.hippoRoot).saveObject(site.tenantId, d.kind, objectSave(site, d.kind, draft)));
}

export async function saveObject<K extends SavableKind, W>(
  objects: Objects,
  d: SavableDescriptor<K, W>,
  site: ObjectSaveSite,
  opts: W
): Promise<ObjectByKind[K]> {
  assertTenantId(d.fn.save, site.tenantId);
  const draft = d.draft(opts);
  return saved(d, site.tenantId, draft.supersedesId, await objects.saveObject(site.tenantId, d.kind, objectSave(site, d.kind, draft)));
}
