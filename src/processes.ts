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
 * Dual-write atomicity: `saveProcess` writes the memory + processes row (and,
 * when superseding, the predecessor's UPDATE) inside writeEntry's SAVEPOINT
 * 'write_entry' via the afterWrite hook, so a failure in any step rolls all of
 * them back. Pattern matches saveDecision (decisions.ts).
 */

import { BadRequestError } from './api-errors.js';
import { onHandle } from './store/open.js';
import { assertTenantId } from './tenant.js';
import type { KeysetPosition } from './keyset.js';
import type { JsonValue } from './json.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { assertObjectStatus, closeObjectOn, loadObjectByIdOn, loadObjectsOn, saveObject } from './objects/lifecycle.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ProcessStatus = 'active' | 'superseded' | 'closed';

export const VALID_PROCESS_STATES: ReadonlySet<ProcessStatus> = new Set<ProcessStatus>([
  'active',
  'superseded',
  'closed',
]);

function isString(v: JsonValue): v is string {
  return typeof v === 'string';
}

/** DoS / abuse caps on the steps body (untrusted at the HTTP/SDK boundary). */
export const MAX_PROCESS_STEPS = 200;
export const MAX_PROCESS_STEP_LEN = 2000;

export interface Process {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion (forget / consolidate /
   *  archive) proceed without breaking the process row. */
  memoryId: string | null;
  tenantId: string;
  processName: string;
  description: string | null;
  /** Ordered step list (the process body). Stored as a JSON array of strings. */
  steps: string[];
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: ProcessStatus;
  /** Successor process id; set only when status === 'superseded'. */
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

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
    if (!isString(raw)) {
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

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface ProcessRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  process_name: string;
  description: string | null;
  steps: string;
  version: number;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

/** Defensive parse: a malformed legacy steps value reads back as []. */
function parseSteps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isString)) {
      return parsed;
    }
    return [];
  } catch {
    // Legacy garbage reads back as no steps, per the docblock.
    return [];
  }
}

function rowToProcess(row: ProcessRow): Process {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    processName: row.process_name,
    description: row.description,
    steps: parseSteps(row.steps),
    version: row.version,
    // SAFETY: processes.status has a DB CHECK constraint restricting it to
    // 'active' | 'superseded' | 'closed' (CREATE TABLE processes, db.ts).
    status: row.status as ProcessStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    changeSummary: row.change_summary,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const PROCESS_COLS = `
  id, memory_id, tenant_id, process_name, description, steps, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`;

/** The recall-surface content for the memory mirror: name + numbered steps +
 *  optional description, so `hippo recall` shows the process body. */
function buildProcessContent(processName: string, steps: string[], description?: string): string {
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  let content = processName;
  if (numbered) content += `\n\n${numbered}`;
  if (description) content += `\n\nDescription: ${description}`;
  return content;
}

/** What one process write stores, resolved before the write. */
interface ProcessFields {
  readonly processName: string;
  readonly description: string | undefined;
  readonly steps: readonly string[];
}

// No graphType: the graph does not extract processes, so a save or close leaves it alone.
const PROCESS: SavableDescriptor<Process, ProcessRow, never, ProcessFields> = {
  table: 'processes',
  cols: PROCESS_COLS,
  label: 'process',
  plural: 'processes',
  fn: { get: 'loadProcessById', close: 'closeProcess', list: 'loadProcesses', save: 'saveProcess' },
  states: VALID_PROCESS_STATES,
  closableFrom: ['active'],
  ops: { close: 'process_close', create: 'process_create', supersede: 'process_supersede' },
  idKey: 'process_id',
  listFilters: {},
  rowTo: rowToProcess,
  source: 'process',
  versioned: true,
  columns: ['process_name', 'description', 'steps'],
  values: (w) => [w.processName, w.description ?? null, JSON.stringify(w.steps)],
  // Ids and counts only, never the name or the step text.
  createMeta: (w, version) => ({
    version,
    step_count: w.steps.length,
    has_description: w.description !== undefined && w.description !== null && w.description !== '',
  }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a process (or a new version that supersedes an existing one). Writes
 * the memory mirror + the processes row atomically inside writeEntry's SAVEPOINT
 * 'write_entry'. When supersedesProcessId is given, the referenced ACTIVE row is
 * preflighted (status + version) BEFORE the INSERT, then UPDATEd -> superseded in
 * the SAME SAVEPOINT (CAS: WHERE status='active' AND id != <new id>; throws on
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
  assertTenantId(PROCESS.fn.save, tenantId);
  // The name is stored as written, so only a blank one is refused.
  if (!opts.processName || opts.processName.trim().length === 0) {
    throw new BadRequestError('saveProcess: processName is required');
  }
  const steps = validateProcessSteps(opts.steps);
  return saveObject(hippoRoot, PROCESS, tenantId, {
    actor,
    now: new Date().toISOString(),
    fields: { processName: opts.processName, description: opts.description, steps },
    content: buildProcessContent(opts.processName, steps, opts.description),
    tags: opts.extraTags ?? [],
    supersedesId: opts.supersedesProcessId,
    changeSummary: opts.changeSummary,
  });
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
  assertTenantId(PROCESS.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => closeObjectOn(db, PROCESS, tenantId, id, { actor, now }));
}

export function loadProcessById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Process | null {
  assertTenantId(PROCESS.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, PROCESS, tenantId, id));
}

export function loadProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: ListProcessesOpts = {},
): Process[] {
  assertTenantId(PROCESS.fn.list, tenantId);
  assertObjectStatus(PROCESS, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, PROCESS, tenantId, opts));
}

export function loadActiveProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Process[] {
  return loadProcesses(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}
