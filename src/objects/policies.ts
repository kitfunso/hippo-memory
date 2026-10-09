/**
 * Policy first-class object.
 *
 * The "bi-temporal-first" object type: a named rule/statement that is in force
 * over an EFFECTIVE-TIME range and evolves via supersession. Two time axes:
 *
 *  - Valid time (effective time): when the policy is in force in the real world,
 *    as first-class columns `valid_from` (required; defaults to creation time)
 *    and `valid_to` (nullable = open-ended). This is the queryable axis: see
 *    `loadPoliciesAsOf` (the active policies in force at a given valid-time).
 *  - Transaction time (system time): when the row was recorded / retired, via
 *    `created_at` + the supersede chain's `superseded_at`. Present, but
 *    time-travel ("what did we BELIEVE was in force at past system time T") is
 *    deferred to a future version.
 *
 * The delta lifecycle reuses the process/decision supersede machinery verbatim
 * (superseded_by self-FK + CAS + INSERT-preflight + server-derived version +
 * change_summary + supersede tenant-match trigger). It DROPS process's `steps`
 * (a policy has `policy_text`) and ADDS `valid_from`/`valid_to`.
 *
 * The `policies` table is the source of truth (survives memory decay); the
 * memory mirror is for recall only. memory_id is NULLABLE with ON DELETE SET
 * NULL so forget/consolidate/archive gracefully orphans the policy row.
 *
 * Lifecycle: active -> superseded (a newer version replaces it) or active ->
 * closed (retired with no successor). Superseding leaves the predecessor's
 * valid-time range intact (it WAS effective then); only the status flips.
 *
 * Date handling: every date input (savePolicy's valid_from/valid_to,
 * loadPoliciesAsOf's asOfDate) is normalized to canonical ISO-8601 datetime
 * (`toISOString`) at the store boundary BEFORE any persist or compare, so the
 * fixed-width values sort lexically and the half-open [valid_from, valid_to)
 * comparison is correct (a date-only asOf vs a datetime valid_from would
 * otherwise make a same-day policy invisible).
 *
 * Dual-write atomicity: `savePolicy` writes the memory + policies row (and, on
 * supersede, the predecessor's UPDATE) in the `objects` store group's one transaction.
 */

import { BadRequestError } from '../core/api-errors.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Policy, PolicyStatus } from '../store/object-types.js';
import type { Objects, PoliciesInForceQuery } from '../store/port.js';
import { sqliteObjects } from '../store/sqlite/objects-group.js';

export type { Policy, PolicyStatus } from '../store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Date normalization + validation (the bi-temporal correctness core)
// ---------------------------------------------------------------------------

/**
 * Parse + canonicalize a date input to ISO-8601 datetime (`toISOString`). Throws
 * on an unparseable value. Whatever `new Date()` accepts is re-emitted in the
 * single fixed-width canonical form, so date-only and datetime inputs collapse to
 * comparable values and lexical ordering is sound. (Overflow inputs like
 * '2026-02-30' roll forward per JS Date semantics rather than throwing; the
 * stored value is still canonical.)
 */
export function normalizePolicyDate(input: string, label: string = 'date'): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestError(`policy: invalid ${label} "${input}" (expected an ISO-8601 date or datetime)`);
  }
  return d.toISOString();
}

/**
 * Normalize valid_from (defaulting to `nowIso` when undefined) + valid_to (null
 * when undefined), then enforce valid_to > valid_from. Returns the canonical pair.
 */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a policy (or a new version that supersedes an existing one). Writes the
 * memory mirror + the policies row in the `objects` store group's one transaction.
 * valid_from defaults to now; valid_to must be > valid_from (validatePolicyDates).
 * When supersedesPolicyId is given, the referenced ACTIVE row is preflighted
 * (status + version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same
 * transaction; the new version = predecessor.version + 1 (server-derived).
 */
export function savePolicy(
  hippoRoot: string,
  tenantId: string,
  opts: SavePolicyOpts,
  actor: string = 'cli',
): Policy {
  return saveObjectAt(POLICY, { hippoRoot, tenantId, actor }, opts);
}

/**
 * Close (retire) an active policy with no successor. CAS guard WHERE
 * status='active'; 0 changes distinguishes not-found from not-active. A
 * superseded row is terminal and cannot be closed.
 */
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

/**
 * The bi-temporal as-of query: the policies in force at `asOfDate` (a valid-time)
 * per current knowledge. Half-open interval [valid_from, valid_to): a row covers
 * T when valid_from <= asOf AND (valid_to IS NULL OR asOf < valid_to). asOfDate is
 * normalized to canonical datetime first so the lexical comparison is sound.
 *
 * A row is returned when it covers T AND it is the live answer for T:
 *  - `active` rows that cover T, OR
 *  - `superseded` rows that cover T BUT whose successor was not yet effective at T
 *    (successor.valid_from > asOf) - i.e. an earlier version that was genuinely in
 *    force then. This is the core valid-time correctness: a Jan-Jun policy
 *    superseded in May is still the answer for `asof March`. Filtering on
 *    status='active' alone would conflate transaction-time with valid-time; the
 *    successor-aware filter mirrors the existing recall-history.ts asOf pattern.
 *
 * `closed` rows are EXCLUDED: closing is a deliberate transaction-time retirement,
 * and resurrecting closed policies for a historical valid-time is full
 * transaction-time-travel (deferred). Returns an ARRAY (overlapping same-name
 * ranges are allowed in v1). Optionally filtered to one policy_name.
 *
 * Date-only `asOfDate` (YYYY-MM-DD, no time component) resolves to the END
 * of that UTC day (23:59:59.999Z), so "as of [day D]" includes a policy that
 * became effective at any instant during D - this is the read-side fix for the
 * common create-then-asof-today workflow, keeping the stored valid_from honest.
 * A full datetime asOf is used as the precise instant.
 */
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
  return { asOf, name: opts.name, limit: opts.limit ?? 100 };
}
