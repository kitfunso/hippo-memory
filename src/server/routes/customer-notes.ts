// /v1/customer-notes routes.
import { closeCustomerNote, type CustomerNote, loadCustomerNoteById, loadCustomerNotes, MAX_CUSTOMER_LEN, type NoteStatus, saveCustomerNote, type SaveCustomerNoteOpts, VALID_NOTE_STATES } from '../../customer-notes.js';
import { sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, optionalString, requiredString, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

const noteRoutes: VersionedRouteConfig<CustomerNote, NoteStatus, SaveCustomerNoteOpts> = {
  noun: 'customer note',
  field: 'note',
  listField: 'notes',
  statuses: VALID_NOTE_STATES,
  filterParam: 'customer',
  list: (hippoRoot, tenantId, { status, filter, limit, after }) => loadCustomerNotes(hippoRoot, tenantId, { status, customer: filter, limit, after }),
  get: loadCustomerNoteById,
  close: closeCustomerNote,
  save: saveCustomerNote,
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
export async function handleCreateCustomerNote({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
    customer: requiredString(body, 'customer', { max: MAX_CUSTOMER_LEN }),
    note: requiredString(body, 'note', { max: 8192 }),
  }, ctx.actor.subject);
  sendJson(res, 201, { note: customerNote });
  return;
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
