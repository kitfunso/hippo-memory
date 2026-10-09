/**
 * Process first-class object.
 *
 * A `process` is a "living process map": a named, ordered list of steps that
 * evolves over time. Unlike `incident` (open->resolved->closed, no supersede),
 * `process` REUSES the `decision` supersede path as its delta mechanism: a
 * process evolves by being superseded by a NEW VERSION that records what
 * changed (`change_summary`) and the full new state (`steps`), carrying a
 * server-derived `version` counter. The version chain (walk `superseded_by`)
 * is the changelog. Computed structural step-diffing is a deferred v2 read-side
 * feature; the row stores enough to reconstruct any delta
 * (predecessor.steps + successor.steps + change_summary).
 *
 * The `processes` table is the source of truth: a process stays `active`
 * regardless of memory decay. A memory row mirrors the process for recall but
 * is NOT canonical — memory_id is NULLABLE with ON DELETE SET NULL so
 * forget/consolidate/archive gracefully orphans the process row.
 *
 * Lifecycle: active -> superseded (a newer version replaces it; superseded_by
 * points to the successor) or active -> closed (retired with no successor;
 * only an active head closes).
 *
 * Tenant scoping: every helper requires tenantId. BEFORE INSERT/UPDATE triggers
 * enforce processes.tenant_id == the referenced memory's tenant_id, and a
 * superseded_by same-tenant trigger makes cross-tenant supersession
 * unrepresentable. Mirrors the v30 decisions pattern (src/decisions.ts).
 *
 * Dual-write atomicity: `saveProcess` hands the memory and the process to the
 * `objects` store group, which commits them (and, when superseding, the
 * predecessor's UPDATE) together, so a failure in any step rolls all of them back.
 */

import { BadRequestError } from './api-errors.js';
import type { KeysetPosition } from './keyset.js';
import { type JsonValue, isJsonString } from './json.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './objects/lifecycle.js';
import type { Process, ProcessStatus } from './store/object-types.js';

export type { Process, ProcessStatus } from './store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const VALID_PROCESS_STATES: ReadonlySet<ProcessStatus> = new Set<ProcessStatus>([
  'active',
  'superseded',
  'closed',
]);

/** DoS / abuse caps on the steps body (untrusted at the HTTP/SDK boundary). */
export const MAX_PROCESS_STEPS = 200;
export const MAX_PROCESS_STEP_LEN = 2000;

export interface SaveProcessOpts {
  processName: string;
  steps: string[];
  description?: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE process this new version supersedes. */
  supersedesProcessId?: number;
  /** Extra memory tags merged after ['process']. */
  extraTags?: string[];
}

export interface ListProcessesOpts {
  status?: ProcessStatus;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

// ---------------------------------------------------------------------------
// steps validation (untrusted input)
// ---------------------------------------------------------------------------

/**
 * Validate + normalise the steps body. Returns the trimmed step strings
 * (trim-then-store, so ' x ' is stored as 'x'). Throws on a non-array, a
 * non-string / empty element, or a cap breach. Mirrors the incident DoS-cap
 * discipline.
 */
export function validateProcessSteps(steps: JsonValue): string[] {
  if (!Array.isArray(steps)) {
    throw new BadRequestError('saveProcess: steps must be an array of strings');
  }
  if (steps.length > MAX_PROCESS_STEPS) {
    throw new BadRequestError(
      `saveProcess: steps exceeds the ${MAX_PROCESS_STEPS}-step cap (got ${steps.length})`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (!isJsonString(raw)) {
      throw new BadRequestError(`saveProcess: step ${i + 1} is not a string`);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BadRequestError(`saveProcess: step ${i + 1} is empty`);
    }
    if (trimmed.length > MAX_PROCESS_STEP_LEN) {
      throw new BadRequestError(
        `saveProcess: step ${i + 1} exceeds the ${MAX_PROCESS_STEP_LEN}-char cap`,
      );
    }
    out.push(trimmed);
  }
  return out;
}

/** The recall-surface content for the memory mirror: name + numbered steps +
 *  optional description, so `hippo recall` shows the process body. */
function buildProcessContent(processName: string, steps: string[], description?: string): string {
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  let content = processName;
  if (numbered) content += `\n\n${numbered}`;
  if (description) content += `\n\nDescription: ${description}`;
  return content;
}

export const PROCESS: SavableDescriptor<'process', SaveProcessOpts> = {
  kind: 'process',
  label: 'process',
  plural: 'processes',
  fn: { get: 'loadProcessById', close: 'closeProcess', list: 'loadProcesses', save: 'saveProcess' },
  states: VALID_PROCESS_STATES,
  closableFrom: ['active'],
  draft(opts) {
    // The name is stored as written, so only a blank one is refused.
    if (!opts.processName || opts.processName.trim().length === 0) {
      throw new BadRequestError('saveProcess: processName is required');
    }
    const steps = validateProcessSteps(opts.steps);
    return {
      fields: { processName: opts.processName, description: opts.description, steps },
      content: buildProcessContent(opts.processName, steps, opts.description),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesProcessId,
      changeSummary: opts.changeSummary,
      at: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a process (or a new version that supersedes an existing one). Writes
 * the memory mirror + the processes row in the `objects` store group's one
 * transaction. When supersedesProcessId is given, the referenced ACTIVE row is
 * preflighted (status + version) BEFORE the INSERT, then UPDATEd -> superseded in
 * the SAME transaction (CAS: WHERE status='active' AND id != <new id>; throws on
 * changes===0 so a duplicate supersede aborts the whole write). The new row's
 * version = predecessor.version + 1 (server-derived); change_summary carries the
 * delta note. A fresh create has version 1 and change_summary NULL.
 */
export function saveProcess(
  hippoRoot: string,
  tenantId: string,
  opts: SaveProcessOpts,
  actor: string = 'cli',
): Process {
  return saveObjectAt(PROCESS, { hippoRoot, tenantId, actor }, opts);
}

/**
 * Close (retire) an active process with no successor. Updates the processes row
 * only; the memory mirror is not mutated. A superseded row is already
 * terminal in the chain and cannot be closed.
 */
export function closeProcess(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Process {
  return closeObjectAt(hippoRoot, PROCESS, tenantId, id, actor);
}

export function loadProcessById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Process | null {
  return objectByIdAt(hippoRoot, PROCESS, tenantId, id);
}

export function loadProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: ListProcessesOpts = {},
): Process[] {
  return listObjectsAt(hippoRoot, PROCESS, tenantId, opts);
}

export function loadActiveProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Process[] {
  return loadProcesses(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}
