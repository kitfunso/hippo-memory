// /v1/processes routes.
import { closeProcess, loadProcessById, loadProcesses, type Process, type ProcessStatus, saveProcess, type SaveProcessOpts, VALID_PROCESS_STATES } from '../../processes.js';
import { HttpError, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { type JsonValue, isJsonString } from '../../json.js';
import { closeRoute, getRoute, listRoute, optionalString, requiredString, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

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

const processRoutes: VersionedRouteConfig<Process, ProcessStatus, SaveProcessOpts> = {
  noun: 'process',
  field: 'process',
  listField: 'processes',
  statuses: VALID_PROCESS_STATES,
  list: loadProcesses,
  get: loadProcessById,
  close: closeProcess,
  save: saveProcess,
  revise: (body) => {
    const steps = validateProcessStepsBody(body['steps']);
    if (steps.length === 0) {
      throw new HttpError(400, 'steps is required (at least one step) for a supersession');
    }
    const changeSummary = optionalString(body, 'changeSummary', 4096);
    const description = optionalString(body, 'description', 4096);
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
// caps: processName/description/changeSummary 4096, steps 200x2000
// (validateProcessStepsBody). Mirrors /v1/decisions; the delta lifecycle is the
// decision supersede path.
export async function handleCreateProcess({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
    processName: requiredString(body, 'processName', { max: 4096 }),
    steps: validateProcessStepsBody(body['steps']),
    description: optionalString(body, 'description', 4096),
  }, ctx.actor.subject);
  sendJson(res, 201, { process });
  return;
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
