// List, get, close and supersede handlers shared by the typed-object routes; each route file passes one config.
import { HttpError, sendJson } from '../../util/http-util.js';
import { type JsonValue, isJsonString } from '../../util/json.js';
import type { ObjectDescriptor, ObjectListOpts, SavableDescriptor } from '../../objects/descriptor.js';
import { closeObject, listObjects, objectById, saveObject } from '../../objects/lifecycle.js';
import type { ObjectByKind, ObjectKind, SavableKind } from '../../store/object-types.js';
import { requireGroup, type Objects } from '../../store/port.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

export interface ObjectRouteConfig<K extends ObjectKind> {
  /** Names the object in the 404 text, e.g. "customer note". */
  readonly noun: string;
  /** Reply field that carries one object, e.g. "note". */
  readonly field: string;
  /** Reply field that carries a page, e.g. "notes". */
  readonly listField: string;
  /** The bad-status reply lists `object.states` in the set's own order. */
  readonly object: ObjectDescriptor<K>;
  /** List query parameter matched against the kind's filter column, e.g. "customer". */
  readonly filterParam?: string;
}

export interface VersionedRouteConfig<K extends SavableKind, W> extends ObjectRouteConfig<K> {
  readonly object: SavableDescriptor<K, W>;
  /** Checks the body, then returns the successor's write; split in two so a bad body answers 400 before a missing row answers 404. */
  readonly revise: (body: Record<string, JsonValue>) => (existing: ObjectByKind[K], id: number) => W;
}

export interface RequiredStringRule {
  readonly max: number;
  /** The field name is a plural noun, so the replies read "are required" and "exceed". */
  readonly plural?: boolean;
  /** The blank check does not trim, so a value of only spaces passes it. */
  readonly untrimmed?: boolean;
}

export function requiredString(body: Record<string, JsonValue>, key: string, rule: RequiredStringRule): string {
  const value = body[key];
  if (!isJsonString(value) || (rule.untrimmed ? value : value.trim()).length === 0) {
    throw new HttpError(400, `${key} ${rule.plural ? 'are' : 'is'} required (non-empty string)`);
  }
  if (value.length > rule.max) {
    throw new HttpError(400, `${key} ${rule.plural ? 'exceed' : 'exceeds'} ${rule.max}-character cap`);
  }
  return value;
}

export function optionalString(body: Record<string, JsonValue>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!isJsonString(value)) throw new HttpError(400, `${key} must be a string`);
  if (value.length > max) throw new HttpError(400, `${key} exceeds ${max}-character cap`);
  return value;
}

/** The request store's object group; the dispatcher has already answered 501 for a store without it. */
export function objectsOf({ opts }: RouteRequest): Objects {
  return requireGroup(opts.store, 'objects');
}

/** Saves through the request's store as the authenticated caller. */
export function saveFor<K extends SavableKind, W>(rr: RouteRequest, d: SavableDescriptor<K, W>, tenantId: string, actor: string, write: W): Promise<ObjectByKind[K]> {
  return saveObject(objectsOf(rr), d, { hippoRoot: rr.opts.hippoRoot, tenantId, actor }, write);
}

async function found<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, objects: Objects, tenantId: string, id: number): Promise<ObjectByKind[K]> {
  const row = await objectById(objects, cfg.object, tenantId, id);
  if (!row) throw new HttpError(404, `${cfg.noun} ${id} not found`);
  return row;
}

// Limit and cursor are checked before auth and status after it, so a keyless caller gets 400 for the first two and 401 for a bad status.
export async function listRoute<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, rr: RouteRequest): Promise<void> {
  const { req, res, opts, query } = rr;
  const status = query.get('status') ?? 'all';
  const filter = cfg.filterParam === undefined ? null : query.get(cfg.filterParam);
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  const listOpts: ObjectListOpts<K> = { limit: limit + 1, after, filter: filter?.trim() || undefined };
  if (status !== 'all') {
    const states = cfg.object.states;
    if (!isSetMember(states, status)) {
      throw new HttpError(400, `status must be one of: ${[...states].join(' | ')} | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const page = pageOf(await listObjects(objectsOf(rr), cfg.object, ctx.tenantId, listOpts), limit, byCreatedAt);
  sendJson(res, 200, { [cfg.listField]: page.items, next_cursor: page.nextCursor });
}

export async function getRoute<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  sendJson(rr.res, 200, { [cfg.field]: await found(cfg, objectsOf(rr), ctx.tenantId, id) });
}

export async function closeRoute<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  sendJson(rr.res, 200, { [cfg.field]: await closeObject(objectsOf(rr), cfg.object, ctx.tenantId, id, ctx.actor.subject) });
}

export async function supersedeRoute<K extends SavableKind, W>(cfg: VersionedRouteConfig<K, W>, rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const successor = cfg.revise(await parseJsonBody(rr.req, ctx));
  const existing = await found(cfg, objectsOf(rr), ctx.tenantId, id);
  const saved = await saveFor(rr, cfg.object, ctx.tenantId, ctx.actor.subject, successor(existing, id));
  sendJson(rr.res, 200, { [cfg.field]: saved });
}
