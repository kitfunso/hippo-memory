// /v1/processes routes.
import { closeProcess, loadProcessById, loadProcesses, saveProcess, VALID_PROCESS_STATES } from '../../processes.js';
import { HttpError, type JsonValue, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// HTTP-boundary validation for a process `steps` body (untrusted). Returns the
// step strings (saveProcess re-validates + trims, this is the fail-fast 400
// gate). Caps mirror src/processes.ts MAX_PROCESS_STEPS / MAX_PROCESS_STEP_LEN.
function validateProcessStepsBody(raw: JsonValue | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'steps must be an array of strings');
  }
  if (raw.length > 200) {
    throw new HttpError(400, 'steps exceeds 200-step cap');
  }
  for (const item of raw) {
    if (!isJsonString(item)) {
      throw new HttpError(400, 'each step must be a string');
    }
    if (item.trim().length === 0) {
      throw new HttpError(400, 'a step is empty');
    }
    if (item.length > 2000) {
      throw new HttpError(400, 'a step exceeds the 2000-character cap');
    }
  }
  // SAFETY: every item in raw was confirmed to be a string in the loop above.
  return raw as string[];
}

// ── processes (E2 first-class object) ──
//
// 5 routes: POST /v1/processes (new; body processName + steps[] + description),
// GET /v1/processes (list, status filter), GET /v1/processes/:id (show),
// POST /v1/processes/:id/supersede (active -> superseded by a new version; body
// steps[] + changeSummary + description; reuses the predecessor's name),
// POST /v1/processes/:id/close (active -> closed). Bearer-authed + tenant-scoped
// via buildContextWithAuth. status validated against VALID_PROCESS_STATES. DoS
// caps: processName/description/changeSummary 4096, steps 200x2000
// (validateProcessStepsBody). Mirrors /v1/decisions; the delta lifecycle is the
// decision supersede path.
export async function handleCreateProcess({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const processName = body['processName'];
  if (!isJsonString(processName) || processName.trim().length === 0) {
    throw new HttpError(400, 'processName is required (non-empty string)');
  }
  if (processName.length > 4096) {
    throw new HttpError(400, 'processName exceeds 4096-character cap');
  }
  const steps = validateProcessStepsBody(body['steps']);
  const descriptionRaw = body['description'];
  let description: string | undefined;
  if (descriptionRaw !== undefined && descriptionRaw !== null) {
    if (!isJsonString(descriptionRaw)) {
      throw new HttpError(400, 'description must be a string');
    }
    if (descriptionRaw.length > 4096) {
      throw new HttpError(400, 'description exceeds 4096-character cap');
    }
    description = descriptionRaw;
  }
  const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
    processName,
    steps,
    description,
  }, ctx.actor.subject);
  sendJson(res, 201, { process });
  return;
}

export async function handleListProcesses({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let processes;
  if (status === 'all') {
    processes = loadProcesses(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_PROCESS_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    processes = loadProcesses(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { processes });
  return;
}

export async function handleSupersedeProcess({ req, res, opts }: RouteRequest, processSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processSupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const steps = validateProcessStepsBody(body['steps']);
  if (steps.length === 0) {
    throw new HttpError(400, 'steps is required (at least one step) for a supersession');
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
  const descRaw = body['description'];
  let description: string | undefined;
  if (descRaw !== undefined && descRaw !== null) {
    if (!isJsonString(descRaw)) {
      throw new HttpError(400, 'description must be a string');
    }
    if (descRaw.length > 4096) {
      throw new HttpError(400, 'description exceeds 4096-character cap');
    }
    description = descRaw;
  }
  // A supersession is a new version of the SAME process: reuse the
  // predecessor's name. 404 if the target does not exist; saveProcess's
  // in-SAVEPOINT preflight is the authoritative active-state check (409).
  const existing = loadProcessById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `process ${id} not found`);
  }
  const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
    processName: existing.processName,
    steps,
    description,
    changeSummary,
    supersedesProcessId: id,
  }, ctx.actor.subject);
  sendJson(res, 200, { process });
  return;
}

export async function handleCloseProcess({ req, res, opts }: RouteRequest, processCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const process = closeProcess(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { process });
  return;
}

export async function handleGetProcess({ req, res, opts }: RouteRequest, processByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const process = loadProcessById(opts.hippoRoot, ctx.tenantId, id);
  if (!process) {
    throw new HttpError(404, `process ${id} not found`);
  }
  sendJson(res, 200, { process });
  return;
}
