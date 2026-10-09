// /v1/predictions routes.
import { loadConfig } from '../../core/config.js';
import { predictionMirror, VALID_CLOSURE_STATES } from '../../store/predictions.js';
import { requireGroup, type PredictionFilter } from '../../store/port.js';
import { HttpError, MAX_ID_LEN, sendJson } from '../../util/http-util.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isSetMember, MAX_SHORT_FIELD_LEN, parseJsonBody, parseListLimit } from '../validation.js';
import { isJsonString, isJsonNumber } from '../../util/json.js';

// ── prediction first-class object ──
//
// 4 routes: POST /v1/predictions (create), GET /v1/predictions (list),
// GET /v1/predictions/:id (show), POST /v1/predictions/:id/close (close).
// All Bearer-authed + tenant-scoped via buildContextWithAuth. closure_state
// validated against VALID_CLOSURE_STATES (3 states). DoS caps on claim
// (MAX_SHORT_FIELD_LEN chars) + closureNote (2048 chars).
export async function handleCreatePrediction({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const claim = body['claim'];
  if (!isJsonString(claim) || claim.length === 0) {
    throw new HttpError(400, 'claim is required (non-empty string)');
  }
  if (claim.length > MAX_SHORT_FIELD_LEN) {
    throw new HttpError(400, `claim exceeds ${MAX_SHORT_FIELD_LEN}-character cap`);
  }
  const classTag = body['classTag'];
  if (!isJsonString(classTag) || classTag.length === 0) {
    throw new HttpError(400, 'classTag is required (non-empty string)');
  }
  const estimate = body['estimate'];
  let estimateValue: number | undefined;
  if (estimate !== undefined && estimate !== null) {
    if (!isJsonNumber(estimate) || !Number.isFinite(estimate)) {
      throw new HttpError(400, 'estimate must be a finite number');
    }
    estimateValue = estimate;
  }
  const unit = body['unit'];
  let estimateUnit: string | undefined;
  if (unit !== undefined && unit !== null) {
    if (!isJsonString(unit)) {
      throw new HttpError(400, 'unit must be a string');
    }
    estimateUnit = unit;
  }
  const targetDate = body['targetDate'];
  let targetDateValue: string | undefined;
  if (targetDate !== undefined && targetDate !== null) {
    if (!isJsonString(targetDate)) {
      throw new HttpError(400, 'targetDate must be an ISO date string');
    }
    targetDateValue = targetDate;
  }
  const claimed = { classTag, claimText: claim, estimateValue, estimateUnit, targetDate: targetDateValue };
  const mirror = predictionMirror(ctx.tenantId, claimed, loadConfig(opts.hippoRoot).defaultHalfLifeDays);
  const prediction = await requireGroup(opts.store, 'predictions').savePrediction(ctx.tenantId, { ...claimed, mirror }, ctx.actor.subject);
  sendJson(res, 201, { prediction });
}

/** Which rows a list reads; a status other than all or open needs a class, as no store reads one closed state across classes. */
function listFilter(classTag: string | undefined, status: string): PredictionFilter {
  if (status === 'all') return { classTag };
  if (status === 'open') return { classTag, closureState: 'open' };
  if (!isSetMember(VALID_CLOSURE_STATES, status)) {
    throw new HttpError(400, `status must be one of: open | closed | closed-unknown | all (got "${status}")`);
  }
  if (!classTag) {
    throw new HttpError(400, 'status filter (non-open) requires class param');
  }
  return { classTag, closureState: status };
}

export async function handleListPredictions({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class') || undefined;
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  const predictions = await requireGroup(opts.store, 'predictions').listPredictions(ctx.tenantId, { ...listFilter(classTag, status), limit: limit + 1, after });
  const page = pageOf(predictions, limit, byCreatedAt);
  sendJson(res, 200, { predictions: page.items, next_cursor: page.nextCursor });
}

// Reference-class / planning-fallacy detector.
// Order matters: this must match BEFORE /v1/predictions/:id since 'stats'
// is not a number — the :id regex requires \d+ so they don't conflict,
// but routing this first avoids the dispatch order risk.
export async function handlePredictionStats({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class');
  if (!classTag || classTag.length === 0) {
    throw new HttpError(400, 'class param is required');
  }
  if (classTag.length > MAX_ID_LEN) {
    throw new HttpError(400, `class exceeds ${MAX_ID_LEN}-character cap`);
  }
  const ctx = await buildContextWithAuth(req, opts);
  const baserate = await requireGroup(opts.store, 'predictions').predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
  sendJson(res, 200, { baserate });
}

export async function handleGetPrediction({ req, res, opts }: RouteRequest, predictionByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(predictionByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const prediction = await requireGroup(opts.store, 'predictions').predictionById(ctx.tenantId, id);
  if (!prediction) {
    throw new HttpError(404, `prediction ${id} not found`);
  }
  sendJson(res, 200, { prediction });
}

export async function handleClosePrediction({ req, res, opts }: RouteRequest, predictionCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(predictionCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const state = body['state'];
  if (!isJsonString(state) || !isSetMember(VALID_CLOSURE_STATES, state) || state === 'open') {
    throw new HttpError(400, 'state is required and must be one of: closed | closed-unknown');
  }
  const actual = body['actual'];
  let actualValue: number | undefined;
  if (actual !== undefined && actual !== null) {
    if (!isJsonNumber(actual) || !Number.isFinite(actual)) {
      throw new HttpError(400, 'actual must be a finite number');
    }
    actualValue = actual;
  }
  const note = body['note'];
  let closureNote: string | undefined;
  if (note !== undefined && note !== null) {
    if (!isJsonString(note)) {
      throw new HttpError(400, 'note must be a string');
    }
    if (note.length > 2048) {
      throw new HttpError(400, 'note exceeds 2048-character cap');
    }
    closureNote = note;
  }
  const close = { closureState: state, actualValue, closureNote };
  const prediction = await requireGroup(opts.store, 'predictions').closePrediction(ctx.tenantId, id, close, ctx.actor.subject);
  sendJson(res, 200, { prediction });
}
