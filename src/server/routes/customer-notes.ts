// /v1/customer-notes routes.
import { closeCustomerNote, loadCustomerNoteById, loadCustomerNotes, MAX_CUSTOMER_LEN, type NoteStatus, saveCustomerNote, VALID_NOTE_STATES } from '../../customer-notes.js';
import { HttpError, sendJson } from '../../http-util.js';
import type { KeysetPosition } from '../../keyset.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isSetMember, parseJsonBody, parseListLimit } from '../validation.js';
import { isJsonString } from '../../json.js';

// ── E2 customer_note routes ──
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
  const customer = body['customer'];
  if (!isJsonString(customer) || customer.trim().length === 0) {
    throw new HttpError(400, 'customer is required (non-empty string)');
  }
  if (customer.length > MAX_CUSTOMER_LEN) {
    throw new HttpError(400, `customer exceeds ${MAX_CUSTOMER_LEN}-character cap`);
  }
  const note = body['note'];
  if (!isJsonString(note) || note.trim().length === 0) {
    throw new HttpError(400, 'note is required (non-empty string)');
  }
  if (note.length > 8192) {
    throw new HttpError(400, 'note exceeds 8192-character cap');
  }
  const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
    customer,
    note,
  }, ctx.actor.subject);
  sendJson(res, 201, { note: customerNote });
  return;
}

// Named list-opts shape for GET /v1/customer-notes (see the matching
// ProjectBriefListOpts comment above: named interfaces are exempt from
// no-known-value-widening, inline anonymous object types are not).
interface CustomerNoteListOpts {
  status?: NoteStatus;
  customer?: string;
  limit: number;
  after?: KeysetPosition;
}

export async function handleListCustomerNotes({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const customerFilter = query.get('customer');
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  const listOpts: CustomerNoteListOpts = { limit: limit + 1, after };
  if (customerFilter !== null && customerFilter.trim().length > 0) {
    listOpts.customer = customerFilter.trim();
  }
  if (status !== 'all') {
    if (!isSetMember(VALID_NOTE_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const notes = loadCustomerNotes(opts.hippoRoot, ctx.tenantId, listOpts);
  const page = pageOf(notes, limit, byCreatedAt);
  sendJson(res, 200, { notes: page.items, next_cursor: page.nextCursor });
  return;
}

export async function handleSupersedeCustomerNote({ req, res, opts }: RouteRequest, noteSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteSupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const note = body['note'];
  if (!isJsonString(note) || note.trim().length === 0) {
    throw new HttpError(400, 'note is required (non-empty string)');
  }
  if (note.length > 8192) {
    throw new HttpError(400, 'note exceeds 8192-character cap');
  }
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const existing = loadCustomerNoteById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `customer note ${id} not found`);
  }
  const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
    customer: existing.customer,
    note,
    changeSummary,
    supersedesNoteId: id,
  }, ctx.actor.subject);
  sendJson(res, 200, { note: customerNote });
  return;
}

export async function handleCloseCustomerNote({ req, res, opts }: RouteRequest, noteCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const customerNote = closeCustomerNote(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { note: customerNote });
  return;
}

export async function handleGetCustomerNote({ req, res, opts }: RouteRequest, noteByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const customerNote = loadCustomerNoteById(opts.hippoRoot, ctx.tenantId, id);
  if (!customerNote) {
    throw new HttpError(404, `customer note ${id} not found`);
  }
  sendJson(res, 200, { note: customerNote });
  return;
}
