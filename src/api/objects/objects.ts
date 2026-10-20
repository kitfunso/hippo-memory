// The typed objects as one seam: each call names its kind, so the HTTP routes and the CLI verbs make the same calls,
// and the caller's tenant, actor and half-life come from the Context alone.
import type { ObjectByKind, ObjectKind, SavableKind } from '../../base/records/object-types.js';
import { CUSTOMER_NOTE, type SaveCustomerNoteOptions } from '../../domain/objects/customer-notes.js';
import { DECISION, type SaveDecisionOptions } from '../../domain/objects/decisions.js';
import type { ObjectDescriptor, ObjectListOptions, SavableDescriptor } from '../../domain/objects/descriptor.js';
import { INCIDENT } from '../../domain/objects/incidents.js';
import {
  closeObject,
  listObjects,
  objectById,
  saveObject,
  type ObjectSaveSite,
} from '../../domain/objects/lifecycle.js';
import { POLICY, type SavePolicyOptions } from '../../domain/objects/policies.js';
import { PROCESS, type SaveProcessOptions } from '../../domain/objects/processes.js';
import { PROJECT_BRIEF, type SaveProjectBriefOptions } from '../../domain/objects/project-briefs.js';
import { SKILL, type SaveSkillOptions } from '../../domain/objects/skills.js';
import { extractPathTags } from '../../domain/search/path-context.js';
import type { Objects } from '../../store/port.js';
import type { Context } from '../types.js';

export type { ObjectListOptions } from '../../domain/objects/descriptor.js';

/** What a save of each kind takes. */
export interface ObjectWrites {
  decision: SaveDecisionOptions;
  process: SaveProcessOptions;
  policy: SavePolicyOptions;
  skill: SaveSkillOptions;
  project_brief: SaveProjectBriefOptions;
  customer_note: SaveCustomerNoteOptions;
}

/** Where a write was made: a CLI write names its working folder, whose path segments tag the mirror memory. */
export interface WriteOrigin {
  readonly folder: string;
}

/** Each savable kind's descriptor, typed per kind so a generic call gets its kind's write back. */
type SavableDescriptors = { readonly [K in SavableKind]: SavableDescriptor<K, ObjectWrites[K]> };
type ObjectDescriptors = { readonly [K in ObjectKind]: ObjectDescriptor<K> };

const SAVABLE: SavableDescriptors = {
  decision: DECISION,
  process: PROCESS,
  policy: POLICY,
  skill: SKILL,
  project_brief: PROJECT_BRIEF,
  customer_note: CUSTOMER_NOTE,
};

const DESCRIPTORS: ObjectDescriptors = { ...SAVABLE, incident: INCIDENT };

/** The request store's object group; the dispatcher has already answered 501 for a store without it. */
export function objectsOf(ctx: Context): Objects {
  return ctx.store.objects;
}

/** The caller a save of this request records, under the store root's half-life. */
export function saveSiteOf(ctx: Context): ObjectSaveSite {
  return { baseHalfLifeDays: ctx.config.defaultHalfLifeDays, tenantId: ctx.tenantId, actor: ctx.actor.subject };
}

/** The write with the tags its origin adds; a write with no origin keeps its own. */
export function taggedFrom<W extends { extraTags?: string[] }>(write: W, origin: WriteOrigin | undefined): W {
  return origin === undefined ? write : { ...write, extraTags: extractPathTags(origin.folder) };
}

/** The statuses a kind's rows take, in the order its error text lists them. */
export function objectStates<K extends ObjectKind>(kind: K): ReadonlySet<ObjectByKind[K]['status']> {
  return DESCRIPTORS[kind].states;
}

/** The caller's objects of one kind, newest first. */
export function objectList<K extends ObjectKind>(
  ctx: Context,
  kind: K,
  opts: ObjectListOptions<K>,
): Promise<ObjectByKind[K][]> {
  return listObjects(objectsOf(ctx), DESCRIPTORS[kind], ctx.tenantId, opts);
}

/** One object by table id, or null when the caller's tenant has none. */
export function objectGet<K extends ObjectKind>(ctx: Context, kind: K, id: number): Promise<ObjectByKind[K] | null> {
  return objectById(objectsOf(ctx), DESCRIPTORS[kind], ctx.tenantId, id);
}

/** Retires one object as the caller; its mirror memory stays as saved. */
export function objectClose<K extends ObjectKind>(ctx: Context, kind: K, id: number): Promise<ObjectByKind[K]> {
  return closeObject(objectsOf(ctx), DESCRIPTORS[kind], ctx.tenantId, id, ctx.actor.subject);
}

/** Creates an object, or the version that replaces the one its write names, with its mirror memory in one write. */
export function objectCreate<K extends SavableKind>(
  ctx: Context,
  kind: K,
  write: ObjectWrites[K],
  origin?: WriteOrigin,
): Promise<ObjectByKind[K]> {
  return saveObject(objectsOf(ctx), SAVABLE[kind], saveSiteOf(ctx), taggedFrom(write, origin));
}

/** The version that replaces object `id`, built from it by `next`, or null when the tenant has no such object; the
 * save's own check that `id` is still active is the one that counts. */
export async function objectSupersede<K extends SavableKind>(
  ctx: Context,
  kind: K,
  id: number,
  next: (existing: ObjectByKind[K]) => ObjectWrites[K],
  origin?: WriteOrigin,
): Promise<ObjectByKind[K] | null> {
  const existing = await objectGet(ctx, kind, id);
  if (existing === null) return null;
  return objectCreate(ctx, kind, next(existing), origin);
}
