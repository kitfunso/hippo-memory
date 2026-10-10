// /v1/processes routes.
import { MAX_PROCESS_STEP_LEN, MAX_PROCESS_STEPS, PROCESS, type SaveProcessOpts } from '../../objects/processes.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, parseJsonBody } from '../validation.js';
import { type JsonValue, isJsonString } from '../../util/json.js';
import { saveFor } from '../../api/objects.js';
import { closeRoute, getRoute, listRoute, optionalString, requiredString, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

// HTTP-boundary validation for a process `steps` body (untrusted). Returns the
// step strings (saveProcess re-validates + trims, this is the fail-fast 400
// gate).
function validateProcessStepsBody(raw: JsonValue | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'steps must be an array of strings');
  }
  if (raw.length > MAX_PROCESS_STEPS) {
    throw new HttpError(400, `steps exceeds ${MAX_PROCESS_STEPS}-step cap`);
  }
  for (const item of raw) {
    if (!isJsonString(item)) {
      throw new HttpError(400, 'each step must be a string');
    }
    if (item.trim().length === 0) {
      throw new HttpError(400, 'a step is empty');
    }
    if (item.length > MAX_PROCESS_STEP_LEN) {
      throw new HttpError(400, `a step exceeds the ${MAX_PROCESS_STEP_LEN}-character cap`);
    }
  }
  // SAFETY: every item in raw was confirmed to be a string in the loop above.
  return raw as string[];
}

const processRoutes: VersionedRouteConfig<'process', SaveProcessOpts> = {
  noun: 'process',
  field: 'process',
  listField: 'processes',
  object: PROCESS,
  revise: (body) => {
    const steps = validateProcessStepsBody(body['steps']);
    if (steps.length === 0) {
      throw new HttpError(400, 'steps is required (at least one step) for a supersession');
    }
    const changeSummary = optionalString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    const description = optionalString(body, 'description', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({ processName: existing.processName, steps, description, changeSummary, supersedesProcessId: id });
  },
};

// ── processes (first-class object) ──
//
// 5 routes: POST /v1/processes (new; body processName + steps[] + description),
// GET /v1/processes (list, status filter), GET /v1/processes/:id (show),
// POST /v1/processes/:id/supersede (active -> superseded by a new version; body
// steps[] + changeSummary + description; reuses the predecessor's name),
// POST /v1/processes/:id/close (active -> closed). Bearer-authed + tenant-scoped
// via buildContextWithAuth. status validated against VALID_PROCESS_STATES. DoS
// caps: processName/description/changeSummary MAX_SHORT_FIELD_LEN, steps MAX_PROCESS_STEPS x MAX_PROCESS_STEP_LEN
// (validateProcessStepsBody). Mirrors /v1/decisions; the delta lifecycle is the
// decision supersede path.
export async function handleCreateProcess(rr: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const process = await saveFor(ctx, PROCESS, {
    processName: requiredString(body, 'processName', { max: MAX_SHORT_FIELD_LEN }),
    steps: validateProcessStepsBody(body['steps']),
    description: optionalString(body, 'description', MAX_SHORT_FIELD_LEN),
  });
  sendJson(rr.res, 201, { process });
}

export function handleListProcesses(rr: RouteRequest): Promise<void> {
  return listRoute(processRoutes, rr);
}

export function handleSupersedeProcess(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(processRoutes, rr, match);
}

export function handleCloseProcess(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(processRoutes, rr, match);
}

export function handleGetProcess(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(processRoutes, rr, match);
}
