// /v1/customer-notes routes; the store validates and throws, and the boundary maps validation to 400, not-found to 404
// and not-active to 409.
import { OBJECT_CAPS } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { getString, requiredString } from '../validation.js';
import type { VersionedRouteConfig } from './object-routes.js';

const NOTE = { max: OBJECT_CAPS.note };

export const CUSTOMER_NOTE_ROUTES: VersionedRouteConfig<'customer_note'> = {
  base: '/v1/customer-notes',
  kind: 'customer_note',
  noun: 'customer note',
  field: 'note',
  listField: 'notes',
  filterParam: 'customer',
  create: (ctx, body) =>
    objectCreate(ctx, 'customer_note', {
      customer: requiredString(body, 'customer', { max: OBJECT_CAPS.customer }),
      note: requiredString(body, 'note', NOTE),
    }),
  revise: (body) => {
    const note = requiredString(body, 'note', NOTE);
    const changeSummary = getString(body, 'changeSummary', OBJECT_CAPS.noteChange);
    return (existing, id) => ({ customer: existing.customer, note, changeSummary, supersedesNoteId: id });
  },
};
