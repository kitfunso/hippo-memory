/** Process object: a named, ordered list of `steps` that evolves by supersession, each version recording `change_summary` and a server-derived `version`.
 *  The `processes` table is the source of truth; the memory mirror (memory_id NULLABLE, ON DELETE SET NULL) is for recall.
 *  Structural step-diffing is a deferred read-side feature; the version chain is the changelog. */

import { BadRequestError } from '../core/api-errors.js';
import type { KeysetPosition } from '../util/keyset.js';
import { type JsonValue, isJsonString } from '../util/json.js';
import type { SavableDescriptor } from './descriptor.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Process, ProcessStatus } from '../core/object-types.js';

export type { Process, ProcessStatus } from '../core/object-types.js';

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

/** Validate and trim the steps body; throws on a non-array, a non-string or empty element, or a cap breach. */
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

/** Create a process, or a new version superseding an existing one, in the `objects` store group's one transaction.
 *  The supersede CAS (WHERE status='active' AND id != <new id>) throws on changes===0 so a duplicate supersede aborts the write. */
export function saveProcess(
  hippoRoot: string,
  tenantId: string,
  opts: SaveProcessOpts,
  actor: string = 'cli',
): Process {
  return saveObjectAt(PROCESS, { hippoRoot, tenantId, actor }, opts);
}

/** Close (retire) an active process with no successor; a superseded row cannot be closed. */
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
