/** Policy object: a rule in force over a valid-time range [valid_from, valid_to), evolving via supersession;
 *  `policiesAsOf` queries it. Transaction-time travel is deferred; superseding keeps the predecessor's range.
 *  Dates are normalized to ISO-8601 (`toISOString`) at the store boundary, so lexical half-open comparison is sound. */

import { DEFAULT_LIST_LIMIT } from '../../base/util/limits.js';
import { BadRequestError } from '../../base/errors/api-errors.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import type { SavableDescriptor } from './descriptor.js';
import { requireText } from './fields.js';
import { listObjects } from './lifecycle.js';
import type { Policy, PolicyStatus } from '../../base/records/object-types.js';
import type { Objects, PoliciesInForceQuery } from '../../base/ports/store.js';

export type { Policy, PolicyStatus } from '../../base/records/object-types.js';

export const VALID_POLICY_STATES: ReadonlySet<PolicyStatus> = new Set<PolicyStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface SavePolicyOptions {
  policyName: string;
  policyText: string;
  /** ISO-8601; normalized to canonical datetime. Defaults to now when omitted. */
  validFrom?: string;
  /** ISO-8601; normalized; must be > validFrom. null/undefined = open-ended. */
  validTo?: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE policy this new version supersedes. */
  supersedesPolicyId?: number;
  /** Extra memory tags merged after ['policy']. */
  extraTags?: string[];
}

export interface ListPoliciesOptions {
  status?: PolicyStatus;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

/** Parse a date input to a fixed-width ISO-8601 datetime so lexical ordering is sound; throws on an unparseable value.
 *  Overflow inputs like '2026-02-30' roll forward per JS Date semantics. */
export function normalizePolicyDate(input: string, label: string = 'date'): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(
      `policy: invalid ${label} "${input}" (expected an ISO-8601 date or datetime)`,
    );
  }
  return d.toISOString();
}

/** Normalize valid_from (default `nowIso`) and valid_to (default null), then enforce valid_to >
 * valid_from. */
export function validatePolicyDates(
  validFromRaw: string | undefined,
  validToRaw: string | undefined,
  nowIso: string,
) {
  const validFrom =
    validFromRaw !== undefined ? normalizePolicyDate(validFromRaw, 'valid_from') : nowIso;
  const validTo =
    validToRaw !== undefined && validToRaw !== null
      ? normalizePolicyDate(validToRaw, 'valid_to')
      : null;
  if (validTo !== null && validTo <= validFrom) {
    throw new BadRequestError(
      `policy: valid_to (${validTo}) must be strictly after valid_from (${validFrom})`,
    );
  }
  return { validFrom, validTo };
}

/** Recall-surface content for the memory mirror: name + rule + effective range. */
function buildPolicyContent({
  policyName,
  policyText,
  validFrom,
  validTo,
}: Pick<Policy, 'policyName' | 'policyText' | 'validFrom' | 'validTo'>): string {
  const range = validTo ? `${validFrom} to ${validTo}` : `${validFrom} onward`;
  return `${policyName}\n\n${policyText}\n\nEffective: ${range}`;
}

export const POLICY: SavableDescriptor<'policy', SavePolicyOptions> = {
  kind: 'policy',
  label: 'policy',
  plural: 'policies',
  states: VALID_POLICY_STATES,
  closableFrom: ['active'],
  draft(opts, now) {
    const policyName = requireText(opts.policyName, MAX_SHORT_FIELD_LEN, 'policyName');
    const policyText = requireText(opts.policyText, MAX_SHORT_FIELD_LEN, 'policyText');
    const at = now.toISOString();
    // valid_from defaults to the creation instant. A date-only as-of is widened to end-of-day on
    // the read side, because backdating valid_from to midnight would report the policy in force
    // earlier that day.
    const { validFrom, validTo } = validatePolicyDates(opts.validFrom, opts.validTo, at);
    return {
      fields: { policyName, policyText, validFrom, validTo },
      content: buildPolicyContent({ policyName, policyText, validFrom, validTo }),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesPolicyId,
      changeSummary: opts.changeSummary,
      at,
    };
  },
};

export function loadPolicies(
  objects: Objects,
  tenantId: string,
  opts: ListPoliciesOptions = {},
): Promise<Policy[]> {
  return listObjects(objects, POLICY, tenantId, opts);
}

/** The policies in force at `asOfDate` (valid-time, half-open [valid_from, valid_to)); superseded rows still answer
 *  while the successor is not yet effective. `closed` rows are excluded; a date-only asOfDate means the END of that UTC
 *  day (23:59:59.999Z), so a policy created today shows up in "as of today". */
export async function policiesAsOf(
  objects: Objects,
  tenantId: string,
  asOfDate: string,
  opts: { name?: string; limit?: number } = {},
): Promise<Policy[]> {
  return objects.listObjects(tenantId, 'policy', inForceQuery(tenantId, asOfDate, opts));
}

/** The as-of read, checked before a store is asked. */
function inForceQuery(
  tenantId: string,
  asOfDate: string,
  opts: { name?: string; limit?: number },
): PoliciesInForceQuery {
  assertTenantId('policiesAsOf', tenantId);
  // A bare date means the whole of that day, so it reads as the day's last instant; a datetime is
  // used as given.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate.trim())
    ? normalizePolicyDate(`${asOfDate.trim()}T23:59:59.999Z`, 'asOfDate')
    : normalizePolicyDate(asOfDate, 'asOfDate');
  return { asOf, name: opts.name, limit: opts.limit ?? DEFAULT_LIST_LIMIT };
}
