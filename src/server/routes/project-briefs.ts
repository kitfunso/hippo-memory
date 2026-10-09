// /v1/project-briefs routes.
import { assembleBriefFromReceipts, type BriefStatus, closeProjectBrief, loadProjectBriefById, loadProjectBriefs, MAX_REPO_LEN, type ProjectBrief, refreshBrief, saveProjectBrief, type SaveProjectBriefOpts, VALID_BRIEF_STATES } from '../../project-briefs.js';
import { sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, optionalString, requiredString, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

const briefRoutes: VersionedRouteConfig<ProjectBrief, BriefStatus, SaveProjectBriefOpts> = {
  noun: 'project brief',
  field: 'brief',
  listField: 'briefs',
  statuses: VALID_BRIEF_STATES,
  filterParam: 'repo',
  list: (hippoRoot, tenantId, { status, filter, limit, after }) => loadProjectBriefs(hippoRoot, tenantId, { status, repo: filter, limit, after }),
  get: loadProjectBriefById,
  close: closeProjectBrief,
  save: saveProjectBrief,
  revise: (body) => {
    const summary = requiredString(body, 'summary', { max: 8192 });
    const changeSummary = optionalString(body, 'changeSummary', 4096);
    return (existing, id) => ({ repo: existing.repo, summary, changeSummary, supersedesBriefId: id });
  },
};

// ── project_brief routes ──
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
  const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
    repo: requiredString(body, 'repo', { max: MAX_REPO_LEN }),
    summary: requiredString(body, 'summary', { max: 8192 }),
  }, ctx.actor.subject);
  sendJson(res, 201, { brief });
}

export function handleListProjectBriefs(rr: RouteRequest): Promise<void> {
  return listRoute(briefRoutes, rr);
}

// The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric
// so the /(\d+)/ routes would not match it, but order it first).
export async function handleRefreshProjectBrief({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const repo = requiredString(body, 'repo', { max: MAX_REPO_LEN });
  if (body['dryRun'] === true) {
    const { markdown, receiptCount } = assembleBriefFromReceipts(opts.hippoRoot, ctx.tenantId, repo);
    sendJson(res, 200, { markdown, receiptCount });
    return;
  }
  const brief = refreshBrief(opts.hippoRoot, ctx.tenantId, repo, ctx.actor.subject);
  sendJson(res, 200, { brief });
}

export function handleSupersedeProjectBrief(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(briefRoutes, rr, match);
}

export function handleCloseProjectBrief(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(briefRoutes, rr, match);
}

export function handleGetProjectBrief(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(briefRoutes, rr, match);
}
