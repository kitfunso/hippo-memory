// /v1/customer-notes routes.
import {
  CUSTOMER_NOTE,
  MAX_CHANGE_SUMMARY_LEN,
  MAX_CUSTOMER_LEN,
  type SaveCustomerNoteOpts,
} from '../../objects/customer-notes.js';
import { sendJson } from '../../util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { saveFor } from '../../api/objects/objects.js';
import {
  closeRoute,
  getRoute,
  listRoute,
  optionalString,
  requiredString,
  supersedeRoute,
  type VersionedRouteConfig,
} from './object-routes.js';

const noteRoutes: VersionedRouteConfig<'customer_note', SaveCustomerNoteOpts> = {
  noun: 'customer note',
  field: 'note',
  listField: 'notes',
  object: CUSTOMER_NOTE,
  filterParam: 'customer',
  revise: (body) => {
    const note = requiredString(body, 'note', { max: 8192 });
    const changeSummary = optionalString(body, 'changeSummary', MAX_CHANGE_SUMMARY_LEN);
    return (existing, id) => ({ customer: existing.customer, note, changeSummary, supersedesNoteId: id });
  },
};

// Routes: customer notes under /v1/customer-notes (create, list, show, supersede, close), mirroring /v1/project-briefs.
// The store validates and throws;
// the boundary maps validation -> 400, not-found -> 404, not-active -> 409.
export async function handleCreateCustomerNote(rr: AuthedRouteRequest<'objects'>): Promise<void> {
  const { ctx } = rr;
  const body = await parseJsonBody(rr.req, ctx);
  const customerNote = await saveFor(ctx, CUSTOMER_NOTE, {
    customer: requiredString(body, 'customer', { max: MAX_CUSTOMER_LEN }),
    note: requiredString(body, 'note', { max: 8192 }),
  });
  sendJson(rr.res, 201, { note: customerNote });
}

export function handleListCustomerNotes(rr: AuthedRouteRequest<'objects'>): Promise<void> {
  return listRoute(noteRoutes, rr);
}

export function handleSupersedeCustomerNote(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(noteRoutes, rr, match);
}

export function handleCloseCustomerNote(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return closeRoute(noteRoutes, rr, match);
}

export function handleGetCustomerNote(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return getRoute(noteRoutes, rr, match);
}
