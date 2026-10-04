// /v1/predictions routes.
import { closePrediction, computePredictionBaserate, loadOpenPredictions, loadPredictionById, loadPredictionsByClass, savePrediction, VALID_CLOSURE_STATES } from '../../predictions/store.js';
import { HttpError, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { isJsonNumber, isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// ── E2 prediction first-class object (v0.31) ──
// docs/plans/2026-05-26-e2-prediction-object.md
//
// 4 routes: POST /v1/predictions (create), GET /v1/predictions (list),
// GET /v1/predictions/:id (show), POST /v1/predictions/:id/close (close).
// All Bearer-authed + tenant-scoped via buildContextWithAuth. closure_state
// validated against VALID_CLOSURE_STATES (3 states). DoS caps on claim
// (4096 chars) + closureNote (2048 chars) per v1.11.4 pattern.
export async function handleCreatePrediction({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const claim = body['claim'];
  if (!isJsonString(claim) || claim.length === 0) {
    throw new HttpError(400, 'claim is required (non-empty string)');
  }
  if (claim.length > 4096) {
    throw new HttpError(400, 'claim exceeds 4096-character cap');
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
  const prediction = savePrediction(opts.hippoRoot, ctx.tenantId, {
    classTag,
    claimText: claim,
    estimateValue,
    estimateUnit,
    targetDate: targetDateValue,
  }, ctx.actor.subject);
  sendJson(res, 201, { prediction });
  return;
}

export async function handleListPredictions({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class') ?? undefined;
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let predictions;
  if (status === 'all') {
    if (classTag) {
      predictions = loadPredictionsByClass(opts.hippoRoot, ctx.tenantId, classTag, { limit });
    } else {
      predictions = loadOpenPredictions(opts.hippoRoot, ctx.tenantId, { limit });
    }
  } else if (status === 'open') {
    predictions = loadOpenPredictions(opts.hippoRoot, ctx.tenantId, {
      classTag: classTag || undefined,
      limit,
    });
  } else {
    if (!isSetMember(VALID_CLOSURE_STATES, status)) {
      throw new HttpError(400, `status must be one of: open | closed | closed-unknown | all (got "${status}")`);
    }
    if (!classTag) {
      throw new HttpError(400, 'status filter (non-open) requires class param');
    }
    predictions = loadPredictionsByClass(opts.hippoRoot, ctx.tenantId, classTag, {
      closureState: status,
      limit,
    });
  }
  sendJson(res, 200, { predictions });
  return;
}

// J3 reference-class / planning-fallacy detector (v0.31).
// Order matters: this must match BEFORE /v1/predictions/:id since 'stats'
// is not a number — the :id regex requires \d+ so they don't conflict,
// but routing this first avoids the dispatch order risk.
export async function handlePredictionStats({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class');
  if (!classTag || classTag.length === 0) {
    throw new HttpError(400, 'class param is required');
  }
  if (classTag.length > 256) {
    throw new HttpError(400, 'class exceeds 256-character cap');
  }
  const ctx = await buildContextWithAuth(req, opts);
  const baserate = computePredictionBaserate(opts.hippoRoot, ctx.tenantId, classTag, ctx.actor.subject);
  sendJson(res, 200, { baserate });
  return;
}

export async function handleGetPrediction({ req, res, opts }: RouteRequest, predictionByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(predictionByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const prediction = loadPredictionById(opts.hippoRoot, ctx.tenantId, id);
  if (!prediction) {
    throw new HttpError(404, `prediction ${id} not found`);
  }
  sendJson(res, 200, { prediction });
  return;
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
  const prediction = closePrediction(opts.hippoRoot, ctx.tenantId, id, {
    closureState: state,
    actualValue,
    closureNote,
  }, ctx.actor.subject);
  sendJson(res, 200, { prediction });
  return;
}
