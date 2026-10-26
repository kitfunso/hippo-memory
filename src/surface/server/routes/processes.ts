// /v1/processes routes: supersede creates a new version that keeps the predecessor's name.
import { OBJECT_CAPS } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { HttpError } from '../../../base/errors/http-errors.js';
import { getString, getStringArray, requiredString } from '../validation.js';
import { MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import type { JsonValue } from '../../../base/util/json.js';
import type { VersionedRouteConfig } from './object-routes.js';

// HTTP-boundary validation for an untrusted process `steps` body; the save re-validates and trims,
// this is the fail-fast 400 gate.
function validateProcessStepsBody(body: Record<string, JsonValue>): string[] {
  return (
    getStringArray({
      obj: body,
      key: 'steps',
      maxItems: OBJECT_CAPS.processSteps,
      maxItemLen: OBJECT_CAPS.processStep,
      rule: {
        nonEmpty: 'trimmed',
        messages: {
          itemType: 'each step must be a string',
          empty: 'a step is empty',
          count: `steps exceeds ${OBJECT_CAPS.processSteps}-step cap`,
          length: `a step exceeds the ${OBJECT_CAPS.processStep}-character cap`,
        },
      },
    }) ?? []
  );
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
      steps: validateProcessStepsBody(body),
      description: getString(body, 'description', MAX_SHORT_FIELD_LEN),
    }),
  revise: (body) => {
    const steps = validateProcessStepsBody(body);
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
