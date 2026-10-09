// /v1/policies routes.
import { policiesAsOf, POLICY, type SavePolicyOpts } from '../../objects/policies.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, objectsOf, optionalString, requiredString, saveFor, supersedeRoute, type VersionedRouteConfig } from './object-routes.js';

// The date fields get a type and length check only: the store parses the date, and the cap bounds a junk string before it reaches the Date parser.
const MAX_DATE_LEN = 64;

const policyRoutes: VersionedRouteConfig<'policy', SavePolicyOpts> = {
  noun: 'policy',
  field: 'policy',
  listField: 'policies',
  object: POLICY,
  revise: (body) => {
    const policyText = requiredString(body, 'policyText', { max: MAX_SHORT_FIELD_LEN });
    const validFrom = optionalString(body, 'validFrom', MAX_DATE_LEN);
    const validTo = optionalString(body, 'validTo', MAX_DATE_LEN);
    const changeSummary = optionalString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({ policyName: existing.policyName, policyText, validFrom, validTo, changeSummary, supersedesPolicyId: id });
  },
};

// ── policies (first-class object, bi-temporal-first) ──
//
// The as-of route is registered BEFORE /:id so the literal 'asof' is matched first; date errors surface as 400.
export async function handleCreatePolicy(rr: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const policy = await saveFor(rr, POLICY, ctx.tenantId, ctx.actor.subject, {
    policyName: requiredString(body, 'policyName', { max: MAX_SHORT_FIELD_LEN }),
    policyText: requiredString(body, 'policyText', { max: MAX_SHORT_FIELD_LEN }),
    validFrom: optionalString(body, 'validFrom', MAX_DATE_LEN),
    validTo: optionalString(body, 'validTo', MAX_DATE_LEN),
  });
  sendJson(rr.res, 201, { policy });
}

export function handleListPolicies(rr: RouteRequest): Promise<void> {
  return listRoute(policyRoutes, rr);
}

// The as-of query: must precede the /:id GET (literal 'asof' is non-numeric so
// the /(\d+)/ route would not match it, but order it first for clarity).
export async function handlePoliciesAsOf(rr: RouteRequest): Promise<void> {
  const { req, res, opts, query } = rr;
  const date = query.get('date');
  if (date === null || date.length === 0) {
    throw new HttpError(400, 'date is required (ISO-8601 valid-time)');
  }
  const name = query.get('name') ?? undefined;
  const ctx = await buildContextWithAuth(req, opts);
  const policies = await policiesAsOf(objectsOf(rr), ctx.tenantId, date, { name });
  sendJson(res, 200, { policies });
}

export function handleSupersedePolicy(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return supersedeRoute(policyRoutes, rr, match);
}

export function handleClosePolicy(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(policyRoutes, rr, match);
}

export function handleGetPolicy(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(policyRoutes, rr, match);
}
