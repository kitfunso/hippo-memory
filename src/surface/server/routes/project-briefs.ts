// /v1/project-briefs routes.
import {
  briefFromReceipts,
  MAX_CHANGE_SUMMARY_LEN,
  MAX_REPO_LEN,
  PROJECT_BRIEF,
  refreshedBrief,
  type SaveProjectBriefOptions,
} from '../../../domain/objects/project-briefs.js';
import { sendJson } from '../../../base/util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody, getString, requiredString } from '../validation.js';
import { objectsOf, saveFor } from '../../../api/objects/objects.js';
import { closeRoute, getRoute, listRoute, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

const briefRoutes: VersionedRouteConfig<'project_brief', SaveProjectBriefOptions> = {
  noun: 'project brief',
  field: 'brief',
  listField: 'briefs',
  object: PROJECT_BRIEF,
  filterParam: 'repo',
  revise: (body) => {
    const summary = requiredString(body, 'summary', { max: 8192 });
    const changeSummary = getString(body, 'changeSummary', MAX_CHANGE_SUMMARY_LEN);
    return (existing, id) => ({ repo: existing.repo, summary, changeSummary, supersedesBriefId: id });
  },
};

// Routes: /v1/project-briefs (create, list, refresh, show, supersede, close), mirroring /v1/skills; /refresh is ordered
// before /:id.
// The store validates and throws; the boundary maps validation -> 400, not-found -> 404, not-active -> 409.
export async function handleCreateProjectBrief(rr: AuthedRouteRequest): Promise<void> {
  const { ctx } = rr;
  const body = await parseJsonBody(rr.req, ctx);
  const brief = await saveFor(ctx, PROJECT_BRIEF, {
    repo: requiredString(body, 'repo', { max: MAX_REPO_LEN }),
    summary: requiredString(body, 'summary', { max: 8192 }),
  });
  sendJson(rr.res, 201, { brief });
}

export function handleListProjectBriefs(rr: AuthedRouteRequest): Promise<void> {
  return listRoute(briefRoutes, rr);
}

// The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric so the /(\d+)/ routes would not match
// it, but order it first).
export async function handleRefreshProjectBrief(rr: AuthedRouteRequest): Promise<void> {
  const { req, res, ctx } = rr;
  const body = await parseJsonBody(req, ctx);
  const repo = requiredString(body, 'repo', { max: MAX_REPO_LEN });
  if (body['dryRun'] === true) {
    const { markdown, receiptCount } = await briefFromReceipts(objectsOf(ctx), ctx.tenantId, repo);
    sendJson(res, 200, { markdown, receiptCount });
    return;
  }
  const brief = await refreshedBrief(
    objectsOf(ctx),
    { baseHalfLifeDays: ctx.config.defaultHalfLifeDays, tenantId: ctx.tenantId, actor: ctx.actor.subject },
    repo,
  );
  sendJson(res, 200, { brief });
}

export function handleSupersedeProjectBrief(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(briefRoutes, rr, match);
}

export function handleCloseProjectBrief(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(briefRoutes, rr, match);
}

export function handleGetProjectBrief(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(briefRoutes, rr, match);
}
