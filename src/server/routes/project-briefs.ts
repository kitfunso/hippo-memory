// /v1/project-briefs routes.
import {
  briefFromReceipts, MAX_CHANGE_SUMMARY_LEN, MAX_REPO_LEN, PROJECT_BRIEF, refreshedBrief, type SaveProjectBriefOpts,
} from '../../objects/project-briefs.js';
import { sendJson } from '../../util/http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { objectsOf, saveFor } from '../../api/objects.js';
import {
  closeRoute,
  getRoute,
  listRoute,
  optionalString,
  requiredString,
  supersedeRoute,
  type VersionedRouteConfig,
} from './object-routes.js';

const briefRoutes: VersionedRouteConfig<'project_brief', SaveProjectBriefOpts> = {
  noun: 'project brief',
  field: 'brief',
  listField: 'briefs',
  object: PROJECT_BRIEF,
  filterParam: 'repo',
  revise: (body) => {
    const summary = requiredString(body, 'summary', { max: 8192 });
    const changeSummary = optionalString(body, 'changeSummary', MAX_CHANGE_SUMMARY_LEN);
    return (existing, id) => ({ repo: existing.repo, summary, changeSummary, supersedesBriefId: id });
  },
};

// Routes: /v1/project-briefs (create, list, refresh, show, supersede, close), mirroring /v1/skills; /refresh is ordered before /:id.
// The store validates and throws; the boundary maps validation -> 400, not-found -> 404, not-active -> 409.
export async function handleCreateProjectBrief(rr: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const brief = await saveFor(ctx, PROJECT_BRIEF, {
    repo: requiredString(body, 'repo', { max: MAX_REPO_LEN }),
    summary: requiredString(body, 'summary', { max: 8192 }),
  });
  sendJson(rr.res, 201, { brief });
}

export function handleListProjectBriefs(rr: RouteRequest): Promise<void> {
  return listRoute(briefRoutes, rr);
}

// The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric
// so the /(\d+)/ routes would not match it, but order it first).
export async function handleRefreshProjectBrief(rr: RouteRequest): Promise<void> {
  const { req, res, opts } = rr;
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const repo = requiredString(body, 'repo', { max: MAX_REPO_LEN });
  if (body['dryRun'] === true) {
    const { markdown, receiptCount } = await briefFromReceipts(objectsOf(ctx), ctx.tenantId, repo);
    sendJson(res, 200, { markdown, receiptCount });
    return;
  }
  const brief = await refreshedBrief(objectsOf(ctx), { hippoRoot: opts.hippoRoot, tenantId: ctx.tenantId, actor: ctx.actor.subject }, repo);
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
