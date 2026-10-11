/** Policy object: a rule in force over a valid-time range [valid_from, valid_to), evolving via supersession; `loadPoliciesAsOf` queries it.
 *  Transaction-time travel (what we believed at past system time T) is deferred. Superseding keeps the predecessor's valid-time range.
 *  All dates are normalised to ISO-8601 (`toISOString`) at the store boundary so the lexical half-open comparison is sound. */

import { DEFAULT_LIST_LIMIT } from '../util/limits.js';
import { BadRequestError } from '../core/api-errors.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Policy, PolicyStatus } from '../core/object-types.js';
import type { Objects, PoliciesInForceQuery } from '../store/port.js';
import { sqliteObjects } from '../store/sqlite/objects-group.js';

export type { Policy, PolicyStatus } from '../core/object-types.js';

export const VALID_POLICY_STATES: ReadonlySet<PolicyStatus> = new Set<PolicyStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface SavePolicyOpts {
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

export interface ListPoliciesOpts {
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
    throw new BadRequestError(`policy: invalid ${label} "${input}" (expected an ISO-8601 date or datetime)`);
  }
  return d.toISOString();
}

/** Normalise valid_from (default `nowIso`) and valid_to (default null), then enforce valid_to > valid_from. */
export function validatePolicyDates(
  validFromRaw: string | undefined,
  validToRaw: string | undefined,
  nowIso: string,
) {
  const validFrom = validFromRaw !== undefined ? normalizePolicyDate(validFromRaw, 'valid_from') : nowIso;
  const validTo = validToRaw !== undefined && validToRaw !== null
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
function buildPolicyContent(
  policyName: string,
  policyText: string,
  validFrom: string,
  validTo: string | null,
): string {
  const range = validTo ? `${validFrom} to ${validTo}` : `${validFrom} onward`;
  return `${policyName}\n\n${policyText}\n\nEffective: ${range}`;
}

export const POLICY: SavableDescriptor<'policy', SavePolicyOpts> = {
  kind: 'policy',
  label: 'policy',
  plural: 'policies',
  fn: { get: 'loadPolicyById', close: 'closePolicy', list: 'loadPolicies', save: 'savePolicy' },
  states: VALID_POLICY_STATES,
  closableFrom: ['active'],
  draft(opts) {
    if (!opts.policyName || opts.policyName.trim().length === 0) {
      throw new BadRequestError('savePolicy: policyName is required');
    }
    if (!opts.policyText || opts.policyText.trim().length === 0) {
      throw new BadRequestError('savePolicy: policyText is required');
    }
    const at = new Date().toISOString();
    // valid_from defaults to the creation instant. A date-only as-of is widened to end-of-day on the read side,
    // because backdating valid_from to midnight would report the policy in force earlier that day.
    const { validFrom, validTo } = validatePolicyDates(opts.validFrom, opts.validTo, at);
    return {
      fields: { policyName: opts.policyName, policyText: opts.policyText, validFrom, validTo },
      content: buildPolicyContent(opts.policyName, opts.policyText, validFrom, validTo),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesPolicyId,
      changeSummary: opts.changeSummary,
      at,
    };
  },
};

/** Create a policy, or a new version superseding an existing one, in the `objects` store group's one transaction.
 *  valid_from defaults to now; valid_to must be > valid_from (validatePolicyDates). */
export function savePolicy(
  hippoRoot: string,
  tenantId: string,
  opts: SavePolicyOpts,
  actor: string = 'cli',
): Policy {
  return saveObjectAt(POLICY, { hippoRoot, tenantId, actor }, opts);
}

/** Close (retire) an active policy with no successor; CAS on status='active', a superseded row is terminal. */
export function closePolicy(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Policy {
  return closeObjectAt(hippoRoot, POLICY, tenantId, id, actor);
}

export function loadPolicyById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Policy | null {
  return objectByIdAt(hippoRoot, POLICY, tenantId, id);
}

export function loadPolicies(
  hippoRoot: string,
  tenantId: string,
  opts: ListPoliciesOpts = {},
): Policy[] {
  return listObjectsAt(hippoRoot, POLICY, tenantId, opts);
}

export function loadActivePolicies(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Policy[] {
  return loadPolicies(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}

/** The policies in force at `asOfDate` (valid-time, half-open [valid_from, valid_to)); superseded rows still answer while the successor is not yet effective.
 *  `closed` rows are excluded; a date-only asOfDate means the END of that UTC day (23:59:59.999Z), so a policy created today shows up in "as of today". */
export function loadPoliciesAsOf(
  hippoRoot: string,
  tenantId: string,
  asOfDate: string,
  opts: { name?: string; limit?: number } = {},
): Policy[] {
  return sqliteObjects(hippoRoot).policiesInForce(tenantId, inForceQuery(tenantId, asOfDate, opts));
}

/** `loadPoliciesAsOf` over a served store's group. */
export async function policiesAsOf(objects: Objects, tenantId: string, asOfDate: string, opts: { name?: string; limit?: number } = {}): Promise<Policy[]> {
  return objects.policiesInForce(tenantId, inForceQuery(tenantId, asOfDate, opts));
}

/** The as-of read, checked before a store is asked. */
function inForceQuery(tenantId: string, asOfDate: string, opts: { name?: string; limit?: number }): PoliciesInForceQuery {
  assertTenantId('loadPoliciesAsOf', tenantId);
  // A bare date means the whole of that day, so it reads as the day's last instant; a datetime is used as given.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate.trim())
    ? normalizePolicyDate(`${asOfDate.trim()}T23:59:59.999Z`, 'asOfDate')
    : normalizePolicyDate(asOfDate, 'asOfDate');
  return { asOf, name: opts.name, limit: opts.limit ?? DEFAULT_LIST_LIMIT };
}
