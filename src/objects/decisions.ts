/** Decision object: the `decisions` table is the source of truth, so an in-force decision stays `active` despite memory decay.
 *  The memory mirror (memory_id NULLABLE, ON DELETE SET NULL) is for recall only; saveDecision commits both in one `objects` transaction. */

import { BadRequestError } from '../core/api-errors.js';
import type { MemoryEntry } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Decision, DecisionStatus } from '../core/object-types.js';
import { objectIdByMemory } from '../store/sqlite/objects-group.js';

export type { Decision, DecisionStatus } from '../core/object-types.js';

const SUPERSEDED_TAG = 'superseded';

export const VALID_DECISION_STATES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface SaveDecisionOpts {
  decisionText: string;
  context?: string;
  /** Table id of an ACTIVE decision this one supersedes; the CLI resolves a `--supersedes <memory-id>`
   *  via resolveActiveDecisionIdByMemory, HTTP/SDK pass the table id. */
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

/** Create a decision; the memory mirror and the row commit in one transaction.
 *  Superseding CASes the old row (WHERE status='active'), so a duplicate supersede aborts the whole write. */
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

/** Close (retire) an active decision with no successor; the memory mirror is not mutated. */
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

/** Resolve a `--supersedes <memory-id>` to the table id of the ACTIVE decision backed by that memory, or null.
 *  Exported so the CLI's backward-compat path is testable at the store layer. */
export function resolveActiveDecisionIdByMemory(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): number | null {
  assertTenantId('resolveActiveDecisionIdByMemory', tenantId);
  return objectIdByMemory(hippoRoot, tenantId, 'decision', 'active', memoryId);
}
