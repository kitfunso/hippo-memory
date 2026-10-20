// /v1/policies routes.
import { policiesInForce } from '../../../api/objects/object-kinds.js';
import { objectCreate } from '../../../api/objects/objects.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { getString, requiredString } from '../validation.js';
import { MAX_DATE_LEN, MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import type { VersionedRouteConfig } from './object-routes.js';

// The date fields get a type and length check only: the store parses the date, and the cap bounds a junk string before
// it reaches the Date parser.

async function handlePoliciesAsOf(rr: AuthedRouteRequest): Promise<void> {
  const { res, query, ctx } = rr;
  const date = query.get('date');
  if (date === null || date.length === 0) {
    throw new HttpError(400, 'date is required (ISO-8601 valid-time)');
  }
  const name = query.get('name') ?? undefined;
  sendJson(res, 200, { policies: await policiesInForce(ctx, date, { name }) });
}

export const POLICY_ROUTES: VersionedRouteConfig<'policy'> = {
  base: '/v1/policies',
  kind: 'policy',
  noun: 'policy',
  field: 'policy',
  listField: 'policies',
  create: (ctx, body) =>
    objectCreate(ctx, 'policy', {
      policyName: requiredString(body, 'policyName', { max: MAX_SHORT_FIELD_LEN }),
      policyText: requiredString(body, 'policyText', { max: MAX_SHORT_FIELD_LEN }),
      validFrom: getString(body, 'validFrom', MAX_DATE_LEN),
      validTo: getString(body, 'validTo', MAX_DATE_LEN),
    }),
  named: [{ method: 'GET', sub: 'asof', handler: handlePoliciesAsOf }],
  revise: (body) => {
    const policyText = requiredString(body, 'policyText', { max: MAX_SHORT_FIELD_LEN });
    const validFrom = getString(body, 'validFrom', MAX_DATE_LEN);
    const validTo = getString(body, 'validTo', MAX_DATE_LEN);
    const changeSummary = getString(body, 'changeSummary', MAX_SHORT_FIELD_LEN);
    return (existing, id) => ({
      policyName: existing.policyName,
      policyText,
      validFrom,
      validTo,
      changeSummary,
      supersedesPolicyId: id,
    });
  },
};
