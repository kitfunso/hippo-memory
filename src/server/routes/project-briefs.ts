// /v1/project-briefs routes.
import { assembleBriefFromReceipts, type BriefStatus, closeProjectBrief, loadProjectBriefById, loadProjectBriefs, refreshBrief, saveProjectBrief, VALID_BRIEF_STATES } from '../../project-briefs.js';
import { HttpError, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// Named list-opts shape for GET /v1/project-briefs (see no-known-value-widening:
// a named interface is not flagged the way an inline anonymous object type is).
interface ProjectBriefListOpts {
  status?: BriefStatus;
  repo?: string;
  limit: number;
}

// ── E2 project_brief routes ──
//
// 6 routes: POST /v1/project-briefs (new; body repo + summary), GET
// /v1/project-briefs (list; status + repo filter; shared parseListLimit), POST
// /v1/project-briefs/refresh (body {repo, dryRun?} -> auto-assemble the brief
// from the repo's receipts; dryRun returns {markdown} without writing; ordered
// before /:id), GET /v1/project-briefs/:id, POST /v1/project-briefs/:id/supersede,
// POST /v1/project-briefs/:id/close. DoS caps: repo 256, summary 8192,
// changeSummary 4096. The store validates + throws; the boundary maps validation
// -> 400, not-found -> 404, not-active -> 409. Mirrors /v1/skills.
export async function handleCreateProjectBrief({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const repo = body['repo'];
  if (!isJsonString(repo) || repo.trim().length === 0) {
    throw new HttpError(400, 'repo is required (non-empty string)');
  }
  if (repo.length > 256) {
    throw new HttpError(400, 'repo exceeds 256-character cap');
  }
  const summary = body['summary'];
  if (!isJsonString(summary) || summary.trim().length === 0) {
    throw new HttpError(400, 'summary is required (non-empty string)');
  }
  if (summary.length > 8192) {
    throw new HttpError(400, 'summary exceeds 8192-character cap');
  }
  const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
    repo,
    summary,
  }, ctx.actor.subject);
  sendJson(res, 201, { brief });
  return;
}

export async function handleListProjectBriefs({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const repoFilter = query.get('repo');
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  const listOpts: ProjectBriefListOpts = { limit };
  if (repoFilter !== null && repoFilter.trim().length > 0) {
    listOpts.repo = repoFilter.trim();
  }
  if (status !== 'all') {
    if (!isSetMember(VALID_BRIEF_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const briefs = loadProjectBriefs(opts.hippoRoot, ctx.tenantId, listOpts);
  sendJson(res, 200, { briefs });
  return;
}

// The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric
// so the /(\d+)/ routes would not match it, but order it first).
export async function handleRefreshProjectBrief({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const repo = body['repo'];
  if (!isJsonString(repo) || repo.trim().length === 0) {
    throw new HttpError(400, 'repo is required (non-empty string)');
  }
  if (repo.length > 256) {
    throw new HttpError(400, 'repo exceeds 256-character cap');
  }
  const dryRun = body['dryRun'] === true;
  if (dryRun) {
    const { markdown, receiptCount } = assembleBriefFromReceipts(opts.hippoRoot, ctx.tenantId, repo);
    sendJson(res, 200, { markdown, receiptCount });
    return;
  }
  const brief = refreshBrief(opts.hippoRoot, ctx.tenantId, repo, ctx.actor.subject);
  sendJson(res, 200, { brief });
  return;
}

export async function handleSupersedeProjectBrief({ req, res, opts }: RouteRequest, briefSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefSupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const summary = body['summary'];
  if (!isJsonString(summary) || summary.trim().length === 0) {
    throw new HttpError(400, 'summary is required (non-empty string)');
  }
  if (summary.length > 8192) {
    throw new HttpError(400, 'summary exceeds 8192-character cap');
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
  const existing = loadProjectBriefById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `project brief ${id} not found`);
  }
  const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
    repo: existing.repo,
    summary,
    changeSummary,
    supersedesBriefId: id,
  }, ctx.actor.subject);
  sendJson(res, 200, { brief });
  return;
}

export async function handleCloseProjectBrief({ req, res, opts }: RouteRequest, briefCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const brief = closeProjectBrief(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { brief });
  return;
}

export async function handleGetProjectBrief({ req, res, opts }: RouteRequest, briefByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const brief = loadProjectBriefById(opts.hippoRoot, ctx.tenantId, id);
  if (!brief) {
    throw new HttpError(404, `project brief ${id} not found`);
  }
  sendJson(res, 200, { brief });
  return;
}
