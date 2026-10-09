/**
 * Decision first-class object.
 *
 * `hippo decide` used to write only a tagged memory (tags ['decision'], source
 * 'decision') with a 90-day half-life, so an in-force decision decayed out of
 * recall even though it was never reversed. The `decisions` table is now the
 * source of truth: a decision stays `active` regardless of memory decay, and
 * `hippo decide list --status active` is authoritative. A memory row still
 * mirrors the decision for recall surfaces but is NOT canonical — memory_id is
 * NULLABLE with ON DELETE SET NULL so forget/consolidate/archive gracefully
 * orphans the decision row.
 *
 * Lifecycle: active -> superseded (a newer decision replaces it; superseded_by
 * points to the successor) or active -> closed (retired with no successor).
 *
 * Tenant scoping: every helper requires tenantId. BEFORE INSERT/UPDATE triggers
 * enforce decisions.tenant_id == the referenced memory's tenant_id, and a
 * superseded_by same-tenant trigger makes cross-tenant supersession
 * unrepresentable. Mirrors the predictions pattern (src/predictions.ts).
 *
 * Dual-write atomicity: `saveDecision` writes the memory + decisions row (and,
 * when superseding, the old row's UPDATE) inside writeEntry's SAVEPOINT
 * 'write_entry' (store/entry-writes.ts) via the afterWrite hook, so a failure in any
 * step rolls all of them back. Pattern matches savePrediction (predictions.ts).
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

export type DecisionStatus = 'active' | 'superseded' | 'closed';

export const VALID_DECISION_STATES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface Decision {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion (forget / consolidate /
   *  archive) proceed without breaking the decision row. */
  memoryId: string | null;
  tenantId: string;
  decisionText: string;
  context: string | null;
  status: DecisionStatus;
  /** Successor decision id; set only when status === 'superseded'. */
  supersededBy: number | null;
  supersededAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface SaveDecisionOpts {
  decisionText: string;
  context?: string;
  /** Table id of an ACTIVE decision this one supersedes. The CLI resolves it
   *  from a `--supersedes <memory-id>` via resolveActiveDecisionIdByMemory;
   *  HTTP/SDK pass the table id directly. */
  supersedesDecisionId?: number;
  /** Extra memory tags merged after ['decision'] (the CLI passes path-context
   *  tags; HTTP/SDK pass none). */
  extraTags?: string[];
}

export interface ListDecisionsOpts {
  status?: DecisionStatus;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  decision_text: string;
  context: string | null;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  closed_at: string | null;
  created_at: string;
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    decisionText: row.decision_text,
    context: row.context,
    // SAFETY: status is DB-constrained to VALID_DECISION_STATES; this module
    // is the only writer and always inserts one of those literal strings.
    status: row.status as DecisionStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const DECISION_COLS = `
  id, memory_id, tenant_id, decision_text, context, status,
  superseded_by, superseded_at, closed_at, created_at
`;

/** What one decision write stores. */
interface DecisionFields {
  readonly decisionText: string;
  readonly context: string | undefined;
}

const DECISION: SavableDescriptor<Decision, DecisionRow, never, DecisionFields> = {
  table: 'decisions',
  cols: DECISION_COLS,
  label: 'decision',
  plural: 'decisions',
  fn: { get: 'loadDecisionById', close: 'closeDecision', list: 'loadDecisions', save: 'saveDecision' },
  states: VALID_DECISION_STATES,
  closableFrom: ['active'],
  ops: { close: 'decision_close', create: 'decision_create', supersede: 'decision_supersede' },
  idKey: 'decision_id',
  graphType: 'decision',
  listFilters: {},
  rowTo: rowToDecision,
  source: 'decision',
  versioned: false,
  columns: ['decision_text', 'context'],
  values: (w) => [w.decisionText, w.context ?? null],
  // An id and a flag only, never the decision text.
  createMeta: (w) => ({ has_context: w.context !== undefined && w.context !== null && w.context !== '' }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a decision. Writes the memory mirror + the decisions row atomically
 * inside writeEntry's SAVEPOINT 'write_entry'. When supersedesDecisionId is
 * given, the referenced ACTIVE row is UPDATEd -> superseded in the SAME
 * SAVEPOINT (CAS: WHERE status='active'; throws on changes===0 so a duplicate
 * supersede aborts the whole write rather than orphaning a successor).
 *
 * The memory mirror preserves the legacy `hippo decide` shape: tags
 * ['decision', ...extraTags], source 'decision', confidence 'verified',
 * the half-life objectHalfLifeDays picks, content = "<text>\n\nContext: <context>"
 * when context is given (so existing recall output is unchanged).
 */
export function saveDecision(
  hippoRoot: string,
  tenantId: string,
  opts: SaveDecisionOpts,
  actor: string = 'cli',
): Decision {
  assertTenantId(DECISION.fn.save, tenantId);
  if (!opts.decisionText) throw new BadRequestError('saveDecision: decisionText is required');
  return saveObject(hippoRoot, DECISION, tenantId, {
    actor,
    now: new Date().toISOString(),
    fields: { decisionText: opts.decisionText, context: opts.context },
    content: opts.context ? `${opts.decisionText}\n\nContext: ${opts.context}` : opts.decisionText,
    tags: opts.extraTags ?? [],
    supersedesId: opts.supersedesDecisionId,
  });
}

/**
 * Close (retire) an active decision with no successor. Updates the decisions
 * row only; the memory mirror is not mutated.
 */
export function closeDecision(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Decision {
  assertTenantId(DECISION.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => {
    const closed = closeObjectOn(db, DECISION, tenantId, id, { actor, now });
    dropClosedObjectFromGraph(hippoRoot, DECISION, tenantId, closed);
    return closed;
  });
}

export function loadDecisionById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Decision | null {
  assertTenantId(DECISION.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, DECISION, tenantId, id));
}

export function loadDecisions(
  hippoRoot: string,
  tenantId: string,
  opts: ListDecisionsOpts = {},
): Decision[] {
  assertTenantId(DECISION.fn.list, tenantId);
  assertObjectStatus(DECISION, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, DECISION, tenantId, opts));
}

export function loadActiveDecisions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Decision[] {
  return loadDecisions(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}

/**
 * Resolve a `--supersedes <memory-id>` (the legacy CLI contract) to the table id
 * of the ACTIVE decision backed by that memory, or null when the memory has no
 * active decision row (a legacy pre-episode decision-tagged memory). Extracted
 * so the CLI's backward-compat path is unit-testable at the store layer without
 * exporting cmdDecide.
 */
export function resolveActiveDecisionIdByMemory(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): number | null {
  assertTenantId('resolveActiveDecisionIdByMemory', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: row shape matches the single `id` column named in the SELECT above.
    const row = db.prepare(
      `SELECT id FROM decisions WHERE memory_id = ? AND tenant_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    ).get(memoryId, tenantId) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    closeHippoDb(db);
  }
}
