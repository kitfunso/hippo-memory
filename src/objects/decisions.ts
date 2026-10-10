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
 * Dual-write atomicity: `saveDecision` hands the memory and the decision to the
 * `objects` store group, which commits them (and, when superseding, the old
 * row's UPDATE) together, so a failure in any step rolls all of them back.
 */

import { BadRequestError } from '../core/api-errors.js';
import type { MemoryEntry } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Decision, DecisionStatus } from '../store/object-types.js';
import { objectIdByMemory } from '../store/sqlite/objects-group.js';

export type { Decision, DecisionStatus } from '../store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

const SUPERSEDED_TAG = 'superseded';

export const VALID_DECISION_STATES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  'active',
  'superseded',
  'closed',
]);

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

export const DECISION: SavableDescriptor<'decision', SaveDecisionOpts> = {
  kind: 'decision',
  label: 'decision',
  plural: 'decisions',
  fn: { get: 'loadDecisionById', close: 'closeDecision', list: 'loadDecisions', save: 'saveDecision' },
  states: VALID_DECISION_STATES,
  closableFrom: ['active'],
  draft(opts) {
    if (!opts.decisionText) throw new BadRequestError('saveDecision: decisionText is required');
    return {
      fields: { decisionText: opts.decisionText, context: opts.context },
      content: opts.context ? `${opts.decisionText}\n\nContext: ${opts.context}` : opts.decisionText,
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesDecisionId,
      at: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a decision. The memory mirror and the decisions row are written in
 * one transaction by the `objects` store group. When supersedesDecisionId is
 * given, the referenced ACTIVE row is UPDATEd -> superseded in the SAME
 * transaction (CAS: WHERE status='active'; zero rows changed means a duplicate
 * supersede aborts the whole write rather than orphaning a successor).
 *
 * The memory mirror preserves the legacy `hippo decide` shape: tags
 * ['decision', ...extraTags], source 'decision', confidence 'verified',
 * the configured default half-life, content = "<text>\n\nContext: <context>"
 * when context is given (so existing recall output is unchanged).
 */
export function saveDecision(
  hippoRoot: string,
  tenantId: string,
  opts: SaveDecisionOpts,
  actor: string = 'cli',
): Decision {
  return saveObjectAt(DECISION, { hippoRoot, tenantId, actor }, opts);
}

/** Weaken the memory a new decision replaces, once the save has committed: half-life halved to a day at least, marked stale, tagged `superseded`. */
export function weakenSupersededMemory(hippoRoot: string, entry: MemoryEntry, actor: string = 'cli'): void {
  const tags = entry.tags.includes(SUPERSEDED_TAG) ? entry.tags : [...entry.tags, SUPERSEDED_TAG];
  const halved = Math.max(1, Math.floor(entry.half_life_days / 2));
  writeEntry(hippoRoot, { ...entry, half_life_days: halved, confidence: 'stale', tags }, { actor });
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
  return closeObjectAt(hippoRoot, DECISION, tenantId, id, actor);
}

export function loadDecisionById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Decision | null {
  return objectByIdAt(hippoRoot, DECISION, tenantId, id);
}

export function loadDecisions(
  hippoRoot: string,
  tenantId: string,
  opts: ListDecisionsOpts = {},
): Decision[] {
  return listObjectsAt(hippoRoot, DECISION, tenantId, opts);
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
 * exporting handleDecide.
 */
export function resolveActiveDecisionIdByMemory(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): number | null {
  assertTenantId('resolveActiveDecisionIdByMemory', tenantId);
  return objectIdByMemory(hippoRoot, tenantId, 'decision', 'active', memoryId);
}
