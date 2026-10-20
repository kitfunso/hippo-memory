// The dashboard's JSON API behind the Health view and the Board; surface/server/dashboard-routes.ts maps each path
// here.
import type * as http from 'http';
import type { Context } from '../../api/index.js';
import { cardDetail, cardList } from '../../api/objects/cards.js';
import type { DashboardRouteRequest } from '../server/dashboard-types.js';
import { readBody, sendJson } from '../../base/util/http-util.js';
import { forgetMemory, markWrong, pinMemory, resolveOpenConflict, type ActionResult } from './dashboard-actions.js';
import {
  parseActionBody,
  parseConflictId,
  parseMemoryId,
  parseMemoryQuery,
  parseSearchText,
  type ActionBody,
} from './dashboard-params.js';

const BODY_MAX_BYTES = 4096;
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;
const CARD_ID = /^[A-Za-z0-9_-]+$/;

type Params = Record<string, string>;

function sendOrNotFound<T extends object>(res: http.ServerResponse, body: T | null): void {
  if (body === null) sendJson(res, 404, { error: 'Not found' });
  else sendJson(res, 200, body);
}

/** The Refresh button's flag: rebuild the snapshot now, not when the cache says. */
const freshOf = (r: DashboardRouteRequest): boolean => r.query.get('fresh') === '1';

export async function overviewRoute(r: DashboardRouteRequest): Promise<void> {
  sendOrNotFound(r.res, await r.reader.overview(freshOf(r)));
}

export async function projectRoute(r: DashboardRouteRequest, { key }: Params): Promise<void> {
  sendOrNotFound(r.res, await r.reader.project(key!, freshOf(r)));
}

export async function memoryPageRoute(r: DashboardRouteRequest, { key }: Params): Promise<void> {
  const query = parseMemoryQuery(r.query);
  sendOrNotFound(r.res, await r.reader.memories(key!, query, freshOf(r)));
}

export async function memoryRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  sendOrNotFound(r.res, await r.reader.memory(parseMemoryId(id!), freshOf(r)));
}

export async function searchRoute(r: DashboardRouteRequest): Promise<void> {
  sendOrNotFound(r.res, await r.reader.search(parseSearchText(r.query), freshOf(r)));
}

export async function cardsRoute(r: DashboardRouteRequest): Promise<void> {
  sendJson(r.res, 200, { cards: await cardList(r.ctx) });
}

export async function cardRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  // The Board has always answered 404, not 400, for an id that does not fit the pattern.
  sendOrNotFound(r.res, CARD_ID.test(id!) ? await cardDetail(r.ctx, id!) : null);
}

type Action = (ctx: Context, body: ActionBody) => Promise<ActionResult>;

// Nothing runs until the content type and the body pass; a committed write then drops the snapshot before the reply.
async function runAction(r: DashboardRouteRequest, action: Action): Promise<void> {
  const { req, res } = r;
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    req.resume();
    return;
  }
  const text = await readBody(req, { maxBytes: BODY_MAX_BYTES, deadlineMs: r.bodyDeadlineMs });
  const result = await action(r.ctx, parseActionBody(text.trim()));
  const touched = result.changed || result.entry !== undefined;
  const detail = touched ? await r.reader.written(result.changed, result.entry) : null;
  sendJson(res, result.status, detail ?? result.body);
}

export function pinRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  return runAction(r, (ctx, body) => pinMemory(ctx, id!, body));
}

export function wrongRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  return runAction(r, (ctx) => markWrong(ctx, id!));
}

export function forgetRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  return runAction(r, (ctx) => forgetMemory(ctx, id!));
}

export function resolveRoute(r: DashboardRouteRequest, { id }: Params): Promise<void> {
  return runAction(r, (ctx, body) => resolveOpenConflict(ctx, parseConflictId(id!), body));
}
