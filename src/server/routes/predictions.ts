// /v1/predictions routes.
import {
  predictionClose,
  predictionList,
  predictionBaserate,
  predictionById,
  predictionRecord,
} from '../../api/objects/predictions.js';
import { VALID_CLOSURE_STATES } from '../../core/prediction.js';
import type { PredictionFilter } from '../../store/port.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { MAX_ID_LEN } from '../../util/limits.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { AuthedRouteRequest } from '../types.js';
import {
  getString,
  isSetMember,
  MAX_DATE_LEN,
  MAX_SHORT_FIELD_LEN,
  parseJsonBody,
  parseListLimit,
  requiredString,
} from '../validation.js';
import { isJsonString, isJsonNumber } from '../../util/json.js';

// Routes: /v1/predictions (create, list, show, close), Bearer-authed and tenant-scoped; closure_state is validated
// against VALID_CLOSURE_STATES.
// DoS caps: claim MAX_SHORT_FIELD_LEN chars, closureNote 2048.
export async function handleCreatePrediction({ req, res, ctx }: AuthedRouteRequest): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const claim = requiredString(body, 'claim', { max: MAX_SHORT_FIELD_LEN, untrimmed: true });
  const classTag = requiredString(body, 'classTag', { max: MAX_ID_LEN, untrimmed: true });
  const estimate = body['estimate'];
  let estimateValue: number | undefined;
  if (estimate !== undefined && estimate !== null) {
    if (!isJsonNumber(estimate) || !Number.isFinite(estimate)) {
      throw new HttpError(400, 'estimate must be a finite number');
    }
    estimateValue = estimate;
  }
  const estimateUnit = getString(body, 'unit', MAX_ID_LEN);
  const targetDate = body['targetDate'];
  if (targetDate !== undefined && targetDate !== null && !isJsonString(targetDate)) {
    throw new HttpError(400, 'targetDate must be an ISO date string');
  }
  const targetDateValue = getString(body, 'targetDate', MAX_DATE_LEN);
  const claimed = { classTag, claimText: claim, estimateValue, estimateUnit, targetDate: targetDateValue };
  const prediction = await predictionRecord(ctx, claimed);
  sendJson(res, 201, { prediction });
}

/**
 * Which rows a list reads; a status other than all or open needs a class, as no store reads one closed state across
 * classes.
 */
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

export async function handleListPredictions({ res, ctx, query }: AuthedRouteRequest): Promise<void> {
  const classTag = query.get('class') || undefined;
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const predictions = await predictionList(ctx, { ...listFilter(classTag, status), limit: limit + 1, after });
  const page = pageOf(predictions, limit, byCreatedAt);
  sendJson(res, 200, { predictions: page.items, next_cursor: page.nextCursor });
}

// Reference-class / planning-fallacy detector; registered BEFORE /v1/predictions/:id so dispatch order cannot matter
// ('stats' is not a number, but routing
// it first is safer).
export async function handlePredictionStats({ res, ctx, query }: AuthedRouteRequest): Promise<void> {
  const classTag = query.get('class');
  if (!classTag || classTag.length === 0) {
    throw new HttpError(400, 'class param is required');
  }
  if (classTag.length > MAX_ID_LEN) {
    throw new HttpError(400, `class exceeds ${MAX_ID_LEN}-character cap`);
  }
  const baserate = await predictionBaserate(ctx, classTag);
  sendJson(res, 200, { baserate });
}

export async function handleGetPrediction(
  { res, ctx }: AuthedRouteRequest,
  predictionByIdMatch: RegExpMatchArray,
): Promise<void> {
  const id = parseInt(predictionByIdMatch[1], 10);
  const prediction = await predictionById(ctx, id);
  if (!prediction) {
    throw new HttpError(404, `prediction ${id} not found`);
  }
  sendJson(res, 200, { prediction });
}

export async function handleClosePrediction(
  { req, res, ctx }: AuthedRouteRequest,
  predictionCloseMatch: RegExpMatchArray,
): Promise<void> {
  const id = parseInt(predictionCloseMatch[1], 10);
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
  const closureNote = getString(body, 'note', 2048);
  const close = { closureState: state, actualValue, closureNote };
  const prediction = await predictionClose(ctx, id, close);
  sendJson(res, 200, { prediction });
}
