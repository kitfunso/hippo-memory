// /v1/project-briefs routes; the store validates and throws, and the boundary maps validation to 400, not-found to 404
// and not-active to 409.
import { briefDigest, briefRefresh, OBJECT_CAPS } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { sendJson } from '../../../base/util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody, getString, requiredString } from '../validation.js';
import type { VersionedRouteConfig } from './object-routes.js';

const SUMMARY = { max: OBJECT_CAPS.briefSummary };

async function handleRefreshProjectBrief(rr: AuthedRouteRequest): Promise<void> {
  const { req, res, ctx } = rr;
  const body = await parseJsonBody(req, ctx);
  const repo = requiredString(body, 'repo', { max: OBJECT_CAPS.repo });
  if (body['dryRun'] === true) {
    const { markdown, receiptCount } = await briefDigest(ctx, repo);
    sendJson(res, 200, { markdown, receiptCount });
    return;
  }
  sendJson(res, 200, { brief: await briefRefresh(ctx, repo) });
}

export const PROJECT_BRIEF_ROUTES: VersionedRouteConfig<'project_brief'> = {
  base: '/v1/project-briefs',
  kind: 'project_brief',
  noun: 'project brief',
  field: 'brief',
  listField: 'briefs',
  filterParam: 'repo',
  create: (ctx, body) =>
    objectCreate(ctx, 'project_brief', {
      repo: requiredString(body, 'repo', { max: OBJECT_CAPS.repo }),
      summary: requiredString(body, 'summary', SUMMARY),
    }),
  named: [{ method: 'POST', sub: 'refresh', handler: handleRefreshProjectBrief }],
  revise: (body) => {
    const summary = requiredString(body, 'summary', SUMMARY);
    const changeSummary = getString(body, 'changeSummary', OBJECT_CAPS.briefChange);
    return (existing, id) => ({ repo: existing.repo, summary, changeSummary, supersedesBriefId: id });
  },
};
