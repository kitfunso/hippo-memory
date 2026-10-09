// /v1/skills routes.
import { exportSkills, MAX_SKILL_NAME_LEN, type SaveSkillOpts, SKILL } from '../../skills.js';
import { sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, optionalString, type RequiredStringRule, requiredString, saveFor, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

const INSTRUCTIONS: RequiredStringRule = { max: 8192, plural: true };

const skillRoutes: VersionedRouteConfig<'skill', SaveSkillOpts> = {
  noun: 'skill',
  field: 'skill',
  listField: 'skills',
  object: SKILL,
  revise: (body) => {
    const instructions = requiredString(body, 'instructions', INSTRUCTIONS);
    const trigger = optionalString(body, 'trigger', 1024);
    const changeSummary = optionalString(body, 'changeSummary', 4096);
    return (existing, id) => ({ skillName: existing.skillName, instructions, trigger, changeSummary, supersedesSkillId: id });
  },
};

// ── skills (first-class object, executable/exportable) ──
//
// 6 routes: POST /v1/skills (new; body skillName + instructions + trigger?),
// GET /v1/skills (list, status filter; shared parseListLimit), GET
// /v1/skills/export (renders ACTIVE skills as an AGENTS.md/CLAUDE.md markdown
// block -> {markdown}; literal 'export' is non-numeric so the /:id (\d+) route
// cannot capture it, but it is ordered first regardless), GET /v1/skills/:id,
// POST /v1/skills/:id/supersede, POST /v1/skills/:id/close. DoS caps:
// skillName 256, instructions 8192, trigger 1024, changeSummary 4096. The store
// validates + throws; the boundary maps validation -> 400, not-found -> 404,
// not-active -> 409. Mirrors /v1/processes; "executable" = exportable
// instruction (no code exec).
export async function handleCreateSkill(rr: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const skill = await saveFor(rr, SKILL, ctx.tenantId, ctx.actor.subject, {
    skillName: requiredString(body, 'skillName', { max: MAX_SKILL_NAME_LEN }),
    instructions: requiredString(body, 'instructions', INSTRUCTIONS),
    trigger: optionalString(body, 'trigger', 1024),
  });
  sendJson(rr.res, 201, { skill });
}

export function handleListSkills(rr: RouteRequest): Promise<void> {
  return listRoute(skillRoutes, rr);
}

// The export renderer: must precede the /:id GET (literal 'export' is
// non-numeric so the /(\d+)/ route would not match it, but order it first).
export async function handleExportSkills({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const markdown = exportSkills(opts.hippoRoot, ctx.tenantId);
  sendJson(res, 200, { markdown });
  return;
}

export function handleSupersedeSkill(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(skillRoutes, rr, match);
}

export function handleCloseSkill(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(skillRoutes, rr, match);
}

export function handleGetSkill(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(skillRoutes, rr, match);
}
