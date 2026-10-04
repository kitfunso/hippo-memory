// /v1/skills routes.
import { closeSkill, exportSkills, loadSkillById, loadSkills, saveSkill, VALID_SKILL_STATES } from '../../skills.js';
import { HttpError, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// ── skills (E2 first-class object, executable/exportable) ──
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
export async function handleCreateSkill({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const skillName = body['skillName'];
  if (!isJsonString(skillName) || skillName.trim().length === 0) {
    throw new HttpError(400, 'skillName is required (non-empty string)');
  }
  if (skillName.length > 256) {
    throw new HttpError(400, 'skillName exceeds 256-character cap');
  }
  const instructions = body['instructions'];
  if (!isJsonString(instructions) || instructions.trim().length === 0) {
    throw new HttpError(400, 'instructions are required (non-empty string)');
  }
  if (instructions.length > 8192) {
    throw new HttpError(400, 'instructions exceed 8192-character cap');
  }
  const triggerRaw = body['trigger'];
  let trigger: string | undefined;
  if (triggerRaw !== undefined && triggerRaw !== null) {
    if (!isJsonString(triggerRaw)) {
      throw new HttpError(400, 'trigger must be a string');
    }
    if (triggerRaw.length > 1024) {
      throw new HttpError(400, 'trigger exceeds 1024-character cap');
    }
    trigger = triggerRaw;
  }
  const skill = saveSkill(opts.hippoRoot, ctx.tenantId, {
    skillName,
    instructions,
    trigger,
  }, ctx.actor.subject);
  sendJson(res, 201, { skill });
  return;
}

export async function handleListSkills({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  let skills;
  if (status === 'all') {
    skills = loadSkills(opts.hippoRoot, ctx.tenantId, { limit: limit + 1, after });
  } else {
    if (!isSetMember(VALID_SKILL_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    skills = loadSkills(opts.hippoRoot, ctx.tenantId, {
      status,
      limit: limit + 1,
      after,
    });
  }
  const page = pageOf(skills, limit, byCreatedAt);
  sendJson(res, 200, { skills: page.items, next_cursor: page.nextCursor });
  return;
}

// The export renderer: must precede the /:id GET (literal 'export' is
// non-numeric so the /(\d+)/ route would not match it, but order it first).
export async function handleExportSkills({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const markdown = exportSkills(opts.hippoRoot, ctx.tenantId);
  sendJson(res, 200, { markdown });
  return;
}

export async function handleSupersedeSkill({ req, res, opts }: RouteRequest, skillSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillSupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const instructions = body['instructions'];
  if (!isJsonString(instructions) || instructions.trim().length === 0) {
    throw new HttpError(400, 'instructions are required (non-empty string)');
  }
  if (instructions.length > 8192) {
    throw new HttpError(400, 'instructions exceed 8192-character cap');
  }
  const triggerRaw = body['trigger'];
  let trigger: string | undefined;
  if (triggerRaw !== undefined && triggerRaw !== null) {
    if (!isJsonString(triggerRaw)) {
      throw new HttpError(400, 'trigger must be a string');
    }
    if (triggerRaw.length > 1024) {
      throw new HttpError(400, 'trigger exceeds 1024-character cap');
    }
    trigger = triggerRaw;
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
  const existing = loadSkillById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `skill ${id} not found`);
  }
  const skill = saveSkill(opts.hippoRoot, ctx.tenantId, {
    skillName: existing.skillName,
    instructions,
    trigger,
    changeSummary,
    supersedesSkillId: id,
  }, ctx.actor.subject);
  sendJson(res, 200, { skill });
  return;
}

export async function handleCloseSkill({ req, res, opts }: RouteRequest, skillCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const skill = closeSkill(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { skill });
  return;
}

export async function handleGetSkill({ req, res, opts }: RouteRequest, skillByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const skill = loadSkillById(opts.hippoRoot, ctx.tenantId, id);
  if (!skill) {
    throw new HttpError(404, `skill ${id} not found`);
  }
  sendJson(res, 200, { skill });
  return;
}
