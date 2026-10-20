// /v1/processes routes: supersede creates a new version that keeps the predecessor's name.
import { OBJECT_CAPS } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { HttpError } from '../../../base/util/http-util.js';
import { getString, requiredString } from '../validation.js';
import { MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import { type JsonValue, isJsonString } from '../../../base/util/json.js';
import type { VersionedRouteConfig } from './object-routes.js';

// HTTP-boundary validation for an untrusted process `steps` body; the save re-validates and trims, this is the
// fail-fast 400 gate.
function validateProcessStepsBody(raw: JsonValue | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'steps must be an array of strings');
  }
  if (raw.length > OBJECT_CAPS.processSteps) {
    throw new HttpError(400, `steps exceeds ${OBJECT_CAPS.processSteps}-step cap`);
  }
  for (const item of raw) {
    if (!isJsonString(item)) {
      throw new HttpError(400, 'each step must be a string');
    }
    if (item.trim().length === 0) {
      throw new HttpError(400, 'a step is empty');
    }
    if (item.length > OBJECT_CAPS.processStep) {
      throw new HttpError(400, `a step exceeds the ${OBJECT_CAPS.processStep}-character cap`);
    }
  }
  // SAFETY: every item in raw was confirmed to be a string in the loop above.
  return raw as string[];
}

export const PROCESS_ROUTES: VersionedRouteConfig<'process'> = {
  base: '/v1/processes',
  kind: 'process',
  noun: 'process',
  field: 'process',
  listField: 'processes',
  create: (ctx, body) =>
    objectCreate(ctx, 'process', {
      processName: requiredString(body, 'processName', { max: MAX_SHORT_FIELD_LEN }),
      steps: validateProcessStepsBody(body['steps']),
      description: getString(body, 'description', MAX_SHORT_FIELD_LEN),
    }),
  revise: (body) => {
    const steps = validateProcessStepsBody(body['steps']);
    if (steps.length === 0) {
      throw new HttpError(400, 'steps is required (at least one step) for a supersession');
    }
    const changeSummary = getString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    const description = getString(body, 'description', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({
      processName: existing.processName,
      steps,
      description,
      changeSummary,
      supersedesProcessId: id,
    });
  },
};
