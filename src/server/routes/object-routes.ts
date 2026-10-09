// List, get, close and supersede handlers shared by the typed-object routes; each route file passes one config.
import { HttpError, sendJson } from '../../http-util.js';
import { type JsonValue, isJsonString } from '../../json.js';
import type { KeysetPosition } from '../../keyset.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

interface PagedRow {
  id: number;
  createdAt: string;
}

export interface ObjectListQuery<S extends string> {
  status?: S;
  /** The trimmed value of the config's `filterParam`; absent when the caller sent none or only spaces. */
  filter?: string;
  limit: number;
  after?: KeysetPosition;
}

export interface ObjectRouteConfig<O extends PagedRow, S extends string> {
  /** Names the object in the 404 text, e.g. "customer note". */
  readonly noun: string;
  /** Reply field that carries one object, e.g. "note". */
  readonly field: string;
  /** Reply field that carries a page, e.g. "notes". */
  readonly listField: string;
  /** Listed in the bad-status reply in this set's own order. */
  readonly statuses: ReadonlySet<S>;
  /** Extra list query parameter, e.g. "customer". */
  readonly filterParam?: string;
  readonly list: (hippoRoot: string, tenantId: string, query: ObjectListQuery<S>) => O[];
  readonly get: (hippoRoot: string, tenantId: string, id: number) => O | null;
  readonly close: (hippoRoot: string, tenantId: string, id: number, actor: string) => O;
}

export interface VersionedRouteConfig<O extends PagedRow, S extends string, W> extends ObjectRouteConfig<O, S> {
  readonly save: (hippoRoot: string, tenantId: string, write: W, actor: string) => O;
  /** Checks the body, then returns the successor's write; split in two so a bad body answers 400 before a missing row answers 404. */
  readonly revise: (body: Record<string, JsonValue>) => (existing: O, id: number) => W;
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

function found<O extends PagedRow, S extends string>(cfg: ObjectRouteConfig<O, S>, hippoRoot: string, tenantId: string, id: number): O {
  const row = cfg.get(hippoRoot, tenantId, id);
  if (!row) throw new HttpError(404, `${cfg.noun} ${id} not found`);
  return row;
}

// Limit and cursor are checked before auth and status after it, so a keyless caller gets 400 for the first two and 401 for a bad status.
export async function listRoute<O extends PagedRow, S extends string>(cfg: ObjectRouteConfig<O, S>, { req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const filter = cfg.filterParam === undefined ? null : query.get(cfg.filterParam);
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  const listQuery: ObjectListQuery<S> = { limit: limit + 1, after, filter: filter?.trim() || undefined };
  if (status !== 'all') {
    if (!isSetMember(cfg.statuses, status)) {
      throw new HttpError(400, `status must be one of: ${[...cfg.statuses].join(' | ')} | all (got "${status}")`);
    }
    listQuery.status = status;
  }
  const page = pageOf(cfg.list(opts.hippoRoot, ctx.tenantId, listQuery), limit, byCreatedAt);
  sendJson(res, 200, { [cfg.listField]: page.items, next_cursor: page.nextCursor });
}

export async function getRoute<O extends PagedRow, S extends string>(cfg: ObjectRouteConfig<O, S>, { req, res, opts }: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  sendJson(res, 200, { [cfg.field]: found(cfg, opts.hippoRoot, ctx.tenantId, id) });
}

export async function closeRoute<O extends PagedRow, S extends string>(cfg: ObjectRouteConfig<O, S>, { req, res, opts }: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  sendJson(res, 200, { [cfg.field]: cfg.close(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject) });
}

export async function supersedeRoute<O extends PagedRow, S extends string, W>(cfg: VersionedRouteConfig<O, S, W>, { req, res, opts }: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const successor = cfg.revise(await parseJsonBody(req, ctx));
  const existing = found(cfg, opts.hippoRoot, ctx.tenantId, id);
  const saved = cfg.save(opts.hippoRoot, ctx.tenantId, successor(existing, id), ctx.actor.subject);
  sendJson(res, 200, { [cfg.field]: saved });
}
