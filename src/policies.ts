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
 * supersede, the predecessor's UPDATE) inside writeEntry's SAVEPOINT.
 */

import { BadRequestError } from './api-errors.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { onHandle } from './store/open.js';
import { assertTenantId } from './tenant.js';
import type { KeysetPosition } from './keyset.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { assertObjectStatus, closeObjectOn, dropClosedObjectFromGraph, loadObjectByIdOn, loadObjectsOn, saveObject } from './objects/lifecycle.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type PolicyStatus = 'active' | 'superseded' | 'closed';

export const VALID_POLICY_STATES: ReadonlySet<PolicyStatus> = new Set<PolicyStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface Policy {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion proceed without breaking
   *  the policy row. */
  memoryId: string | null;
  tenantId: string;
  policyName: string;
  policyText: string;
  /** Canonical ISO-8601 datetime; when the policy takes effect. Always set. */
  validFrom: string;
  /** Canonical ISO-8601 datetime; when it expires. null = open-ended. */
  validTo: string | null;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: PolicyStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

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

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface PolicyRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  policy_name: string;
  policy_text: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

function rowToPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    policyName: row.policy_name,
    policyText: row.policy_text,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    version: row.version,
    // SAFETY: row.status is DB-constrained to PolicyStatus values; every INSERT/
    // UPDATE in this file writes only the literal 'active' | 'superseded' | 'closed'.
    status: row.status as PolicyStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    changeSummary: row.change_summary,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const POLICY_COLS = `
  id, memory_id, tenant_id, policy_name, policy_text, valid_from, valid_to,
  version, status, superseded_by, superseded_at, change_summary, closed_at, created_at
`;

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

/** What one policy write stores, with both dates already normalized. */
interface PolicyFields {
  readonly policyName: string;
  readonly policyText: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

const POLICY: SavableDescriptor<Policy, PolicyRow, never, PolicyFields> = {
  table: 'policies',
  cols: POLICY_COLS,
  label: 'policy',
  plural: 'policies',
  fn: { get: 'loadPolicyById', close: 'closePolicy', list: 'loadPolicies', save: 'savePolicy' },
  states: VALID_POLICY_STATES,
  closableFrom: ['active'],
  ops: { close: 'policy_close', create: 'policy_create', supersede: 'policy_supersede' },
  idKey: 'policy_id',
  graphType: 'policy',
  listFilters: {},
  rowTo: rowToPolicy,
  source: 'policy',
  versioned: true,
  columns: ['policy_name', 'policy_text', 'valid_from', 'valid_to'],
  values: (w) => [w.policyName, w.policyText, w.validFrom, w.validTo],
  // Ids and flags only, never the policy text.
  createMeta: (w, version) => ({ version, open_ended: w.validTo === null }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a policy (or a new version that supersedes an existing one). Writes the
 * memory mirror + the policies row atomically inside writeEntry's SAVEPOINT.
 * valid_from defaults to now; valid_to must be > valid_from (validatePolicyDates).
 * When supersedesPolicyId is given, the referenced ACTIVE row is preflighted
 * (status + version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same
 * SAVEPOINT; the new version = predecessor.version + 1 (server-derived).
 */
export function savePolicy(
  hippoRoot: string,
  tenantId: string,
  opts: SavePolicyOpts,
  actor: string = 'cli',
): Policy {
  assertTenantId(POLICY.fn.save, tenantId);
  if (!opts.policyName || opts.policyName.trim().length === 0) {
    throw new BadRequestError('savePolicy: policyName is required');
  }
  if (!opts.policyText || opts.policyText.trim().length === 0) {
    throw new BadRequestError('savePolicy: policyText is required');
  }

  const now = new Date().toISOString();
  // valid_from defaults to the precise creation instant (the honest effective
  // time). The same-day date-only as-of workflow is handled on the READ side
  // (a date-only asOf resolves to end-of-day in loadPoliciesAsOf), NOT by
  // backdating the stored valid_from - backdating to midnight would make an
  // earlier-same-day as-of wrongly report the policy already in force and would
  // hide a superseded predecessor for that earlier time. An explicit --from is honored as-is.
  const { validFrom, validTo } = validatePolicyDates(opts.validFrom, opts.validTo, now);
  return saveObject(hippoRoot, POLICY, tenantId, {
    actor,
    now,
    fields: { policyName: opts.policyName, policyText: opts.policyText, validFrom, validTo },
    content: buildPolicyContent(opts.policyName, opts.policyText, validFrom, validTo),
    tags: opts.extraTags ?? [],
    supersedesId: opts.supersedesPolicyId,
    changeSummary: opts.changeSummary,
  });
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
  assertTenantId(POLICY.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => {
    const closed = closeObjectOn(db, POLICY, tenantId, id, { actor, now });
    dropClosedObjectFromGraph(hippoRoot, POLICY, tenantId, closed);
    return closed;
  });
}

export function loadPolicyById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Policy | null {
  assertTenantId(POLICY.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, POLICY, tenantId, id));
}

export function loadPolicies(
  hippoRoot: string,
  tenantId: string,
  opts: ListPoliciesOpts = {},
): Policy[] {
  assertTenantId(POLICY.fn.list, tenantId);
  assertObjectStatus(POLICY, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, POLICY, tenantId, opts));
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
  assertTenantId('loadPoliciesAsOf', tenantId);
  // A bare date means "as of (the whole of) that day" -> end-of-day instant; a
  // datetime is used precisely. normalizePolicyDate validates/canonicalizes both.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate.trim())
    ? normalizePolicyDate(`${asOfDate.trim()}T23:59:59.999Z`, 'asOfDate')
    : normalizePolicyDate(asOfDate, 'asOfDate');
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    // LEFT JOIN the successor so a superseded row is kept only while its
    // successor is not yet effective at asOf. p.status != 'closed' drops retired
    // rows; the OR keeps active heads + still-in-force superseded versions.
    const nameClause = opts.name !== undefined ? 'AND p.policy_name = ?' : '';
    const params: Array<string | number> = [tenantId, asOf, asOf, asOf];
    if (opts.name !== undefined) params.push(opts.name);
    params.push(limit);
    // SAFETY: the SELECT list explicitly aliases p.* to exactly the PolicyRow
    // columns (id, memory_id, tenant_id, policy_name, policy_text, valid_from,
    // valid_to, version, status, superseded_by, superseded_at, change_summary,
    // closed_at, created_at); .all() returns rows in that shape.
    const rows = db.prepare(`
      SELECT p.id, p.memory_id, p.tenant_id, p.policy_name, p.policy_text,
             p.valid_from, p.valid_to, p.version, p.status, p.superseded_by,
             p.superseded_at, p.change_summary, p.closed_at, p.created_at
      FROM policies p
      LEFT JOIN policies s ON s.id = p.superseded_by
      WHERE p.tenant_id = ? AND p.status != 'closed'
        AND p.valid_from <= ? AND (p.valid_to IS NULL OR ? < p.valid_to)
        AND (p.status = 'active' OR (s.id IS NOT NULL AND s.valid_from > ?))
        ${nameClause}
      ORDER BY p.valid_from DESC, p.id DESC
      LIMIT ?
    `).all(...params) as PolicyRow[];
    return rows.map(rowToPolicy);
  } finally {
    closeHippoDb(db);
  }
}
