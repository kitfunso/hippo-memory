// /v1/skills routes.
import { MAX_SKILL_NAME_LEN, type SaveSkillOpts, SKILL, skillsMarkdown } from '../../objects/skills.js';
import { sendJson } from '../../util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, parseJsonBody } from '../validation.js';
import { objectsOf, saveFor } from '../../api/objects/objects.js';
import {
  closeRoute,
  getRoute,
  listRoute,
  optionalString,
  type RequiredStringRule,
  requiredString,
  supersedeRoute,
  type VersionedRouteConfig,
} from './object-routes.js';

const INSTRUCTIONS: RequiredStringRule = { max: 8192, plural: true };

const skillRoutes: VersionedRouteConfig<'skill', SaveSkillOpts> = {
  noun: 'skill',
  field: 'skill',
  listField: 'skills',
  object: SKILL,
  revise: (body) => {
    const instructions = requiredString(body, 'instructions', INSTRUCTIONS);
    const trigger = optionalString(body, 'trigger', 1024);
    const changeSummary = optionalString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({
      skillName: existing.skillName,
      instructions,
      trigger,
      changeSummary,
      supersedesSkillId: id,
    });
  },
};

// Routes: /v1/skills (create, list, export, show, supersede, close), mirroring /v1/processes; "executable" means
// exportable instruction (no code exec).
// GET /v1/skills/export renders ACTIVE skills as a markdown block for AGENTS.md or CLAUDE.md and is ordered before
// /:id.
export async function handleCreateSkill(rr: AuthedRouteRequest<'objects'>): Promise<void> {
  const { ctx } = rr;
  const body = await parseJsonBody(rr.req, ctx);
  const skill = await saveFor(ctx, SKILL, {
    skillName: requiredString(body, 'skillName', { max: MAX_SKILL_NAME_LEN }),
    instructions: requiredString(body, 'instructions', INSTRUCTIONS),
    trigger: optionalString(body, 'trigger', 1024),
  });
  sendJson(rr.res, 201, { skill });
}

export function handleListSkills(rr: AuthedRouteRequest<'objects'>): Promise<void> {
  return listRoute(skillRoutes, rr);
}

// The export renderer: must precede the /:id GET (literal 'export' is
// non-numeric so the /(\d+)/ route would not match it, but order it first).
export async function handleExportSkills(rr: AuthedRouteRequest<'objects'>): Promise<void> {
  const { res, ctx } = rr;
  const markdown = await skillsMarkdown(objectsOf(ctx), ctx.tenantId);
  sendJson(res, 200, { markdown });
}

export function handleSupersedeSkill(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(skillRoutes, rr, match);
}

export function handleCloseSkill(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return closeRoute(skillRoutes, rr, match);
}

export function handleGetSkill(rr: AuthedRouteRequest<'objects'>, match: RegExpMatchArray): Promise<void> {
  return getRoute(skillRoutes, rr, match);
}
