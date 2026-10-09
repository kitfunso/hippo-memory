// /v1/customer-notes routes.
import { CUSTOMER_NOTE, MAX_CUSTOMER_LEN, type SaveCustomerNoteOpts } from '../../customer-notes.js';
import { sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, optionalString, requiredString, saveFor, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

const noteRoutes: VersionedRouteConfig<'customer_note', SaveCustomerNoteOpts> = {
  noun: 'customer note',
  field: 'note',
  listField: 'notes',
  object: CUSTOMER_NOTE,
  filterParam: 'customer',
  revise: (body) => {
    const note = requiredString(body, 'note', { max: 8192 });
    const changeSummary = optionalString(body, 'changeSummary', 4096);
    return (existing, id) => ({ customer: existing.customer, note, changeSummary, supersedesNoteId: id });
  },
};

// ── customer_note routes ──
//
// 5 routes (no assembler/refresh): POST /v1/customer-notes (new; body customer +
// note), GET /v1/customer-notes (list; status + customer filter; shared
// parseListLimit), GET /v1/customer-notes/:id, POST /v1/customer-notes/:id/supersede,
// POST /v1/customer-notes/:id/close. DoS caps: customer 256, note 8192,
// changeSummary 4096. The store validates + throws; the boundary maps validation ->
// 400, not-found -> 404, not-active -> 409. Mirrors /v1/project-briefs.
export async function handleCreateCustomerNote(rr: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const customerNote = await saveFor(rr, CUSTOMER_NOTE, ctx.tenantId, ctx.actor.subject, {
    customer: requiredString(body, 'customer', { max: MAX_CUSTOMER_LEN }),
    note: requiredString(body, 'note', { max: 8192 }),
  });
  sendJson(rr.res, 201, { note: customerNote });
}

export function handleListCustomerNotes(rr: RouteRequest): Promise<void> {
  return listRoute(noteRoutes, rr);
}

export function handleSupersedeCustomerNote(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(noteRoutes, rr, match);
}

export function handleCloseCustomerNote(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(noteRoutes, rr, match);
}

export function handleGetCustomerNote(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(noteRoutes, rr, match);
}
