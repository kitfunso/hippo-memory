// The rows of a typed-object kind, from one config: create, list, get and close for every kind, plus supersede for a
// kind that versions. Each handler parses and replies; the work is one api call.
import type { Context } from '../../../api/index.js';
import {
  objectClose,
  objectGet,
  objectList,
  objectStates,
  objectSupersede,
  type ObjectListOptions,
  type ObjectWrites,
} from '../../../api/objects/objects.js';
import { NotFoundError } from '../../../base/errors/api-errors.js';
import type { ObjectByKind, ObjectKind, SavableKind } from '../../../base/records/object-types.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import type { JsonValue } from '../../../base/util/json.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { AuthedRouteRequest, Route } from '../types.js';
import { isSetMember, parseJsonBody, parseListLimit } from '../validation.js';
import { kindRows, type IdHandler, type NamedRoute } from './kind-routes.js';

type Body = Record<string, JsonValue>;

export interface ObjectRouteConfig<K extends ObjectKind> {
  /** The collection path, such as `/v1/customer-notes`. */
  readonly base: string;
  readonly kind: K;
  /** Names the object in the 404 text, e.g. "customer note". */
  readonly noun: string;
  /** Reply field that carries one object, e.g. "note". */
  readonly field: string;
  /** Reply field that carries a page, e.g. "notes". */
  readonly listField: string;
  /** List query parameter matched against the kind's filter column, e.g. "customer". */
  readonly filterParam?: string;
  /** Checks the body, then saves the new object. */
  readonly create: (ctx: Context, body: Body) => Promise<ObjectByKind[K]>;
  readonly named?: readonly NamedRoute[];
  /** `POST /:id/<action>` rows only this kind has; they come before close. */
  readonly actions?: Readonly<Record<string, IdHandler>>;
}

export interface VersionedRouteConfig<K extends SavableKind> extends ObjectRouteConfig<K> {
  /** Checks the body, then returns the successor's write: two steps, so a bad body answers 400 before a missing row
   * answers 404. */
  readonly revise: (body: Body) => (existing: ObjectByKind[K], id: number) => ObjectWrites[K];
}

function notFound<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, id: number): HttpError {
  return new HttpError(404, `${cfg.noun} ${id} not found`);
}

async function createRoute<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, rr: AuthedRouteRequest): Promise<void> {
  const { req, res, ctx } = rr;
  const body = await parseJsonBody(req, ctx);
  try {
    sendJson(res, 201, { [cfg.field]: await cfg.create(ctx, body) });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
}

async function listRoute<K extends ObjectKind>(cfg: ObjectRouteConfig<K>, rr: AuthedRouteRequest): Promise<void> {
  const { res, query, ctx } = rr;
  const status = query.get('status') ?? 'all';
  const filter = cfg.filterParam === undefined ? null : query.get(cfg.filterParam);
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const listOpts: ObjectListOptions<K> = { limit: limit + 1, after, filter: filter?.trim() || undefined };
  if (status !== 'all') {
    const states = objectStates(cfg.kind);
    if (!isSetMember(states, status)) {
      throw new HttpError(400, `status must be one of: ${[...states].join(' | ')} | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const page = pageOf(await objectList(ctx, cfg.kind, listOpts), limit, byCreatedAt);
  sendJson(res, 200, { [cfg.listField]: page.items, next_cursor: page.nextCursor });
}

async function getRoute<K extends ObjectKind>(
  cfg: ObjectRouteConfig<K>,
  rr: AuthedRouteRequest,
  id: number,
): Promise<void> {
  const found = await objectGet(rr.ctx, cfg.kind, id);
  if (found === null) throw notFound(cfg, id);
  sendJson(rr.res, 200, { [cfg.field]: found });
}

async function closeRoute<K extends ObjectKind>(
  cfg: ObjectRouteConfig<K>,
  rr: AuthedRouteRequest,
  id: number,
): Promise<void> {
  sendJson(rr.res, 200, { [cfg.field]: await objectClose(rr.ctx, cfg.kind, id) });
}

async function supersedeRoute<K extends SavableKind>(
  cfg: VersionedRouteConfig<K>,
  rr: AuthedRouteRequest,
  id: number,
): Promise<void> {
  const { ctx } = rr;
  const successor = cfg.revise(await parseJsonBody(rr.req, ctx));
  const saved = await objectSupersede(ctx, cfg.kind, id, (existing) => successor(existing, id));
  if (saved === null) throw notFound(cfg, id);
  sendJson(rr.res, 200, { [cfg.field]: saved });
}

/** Every row of a kind: its own actions, then close, then the id read. */
export function objectRoutes<K extends ObjectKind>(cfg: ObjectRouteConfig<K>): Route[] {
  return kindRows({
    base: cfg.base,
    create: (rr) => createRoute(cfg, rr),
    list: (rr) => listRoute(cfg, rr),
    named: cfg.named,
    actions: { ...cfg.actions, close: (rr, id) => closeRoute(cfg, rr, id) },
    get: (rr, id) => getRoute(cfg, rr, id),
  });
}

/** Every row of a kind that versions: its supersede reads the active row, then saves the successor `revise` builds. */
export function versionedRoutes<K extends SavableKind>(cfg: VersionedRouteConfig<K>): Route[] {
  const supersede: IdHandler = (rr, id) => supersedeRoute(cfg, rr, id);
  return objectRoutes({ ...cfg, actions: { supersede, ...cfg.actions } });
}
