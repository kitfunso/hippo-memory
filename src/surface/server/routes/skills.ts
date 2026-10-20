// /v1/skills routes; "executable" means exportable instruction (no code exec). GET /v1/skills/export renders the active
// skills as one markdown block for AGENTS.md or CLAUDE.md.
import { OBJECT_CAPS, skillsExport } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { sendJson } from '../../../base/util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, getString, requiredString, type RequiredStringRule } from '../validation.js';
import type { VersionedRouteConfig } from './object-routes.js';

const INSTRUCTIONS: RequiredStringRule = { max: OBJECT_CAPS.skillInstructions, plural: true };

async function handleExportSkills({ res, ctx }: AuthedRouteRequest): Promise<void> {
  sendJson(res, 200, { markdown: await skillsExport(ctx) });
}

export const SKILL_ROUTES: VersionedRouteConfig<'skill'> = {
  base: '/v1/skills',
  kind: 'skill',
  noun: 'skill',
  field: 'skill',
  listField: 'skills',
  create: (ctx, body) =>
    objectCreate(ctx, 'skill', {
      skillName: requiredString(body, 'skillName', { max: OBJECT_CAPS.skillName }),
      instructions: requiredString(body, 'instructions', INSTRUCTIONS),
      trigger: getString(body, 'trigger', OBJECT_CAPS.skillTrigger),
    }),
  named: [{ method: 'GET', sub: 'export', handler: handleExportSkills }],
  revise: (body) => {
    const instructions = requiredString(body, 'instructions', INSTRUCTIONS);
    const trigger = getString(body, 'trigger', OBJECT_CAPS.skillTrigger);
    const changeSummary = getString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({
      skillName: existing.skillName,
      instructions,
      trigger,
      changeSummary,
      supersedesSkillId: id,
    });
  },
};
