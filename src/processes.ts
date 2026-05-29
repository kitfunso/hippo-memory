/**
 * E2 process first-class object (docs/plans/2026-05-29-e2-process-object.md).
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

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, PROCESS_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ProcessStatus = 'active' | 'superseded' | 'closed';

export const VALID_PROCESS_STATES: ReadonlySet<ProcessStatus> = new Set<ProcessStatus>([
  'active',
  'superseded',
  'closed',
]);

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
export function validateProcessSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) {
    throw new Error('saveProcess: steps must be an array of strings');
  }
  if (steps.length > MAX_PROCESS_STEPS) {
    throw new Error(
      `saveProcess: steps exceeds the ${MAX_PROCESS_STEPS}-step cap (got ${steps.length})`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (typeof raw !== 'string') {
      throw new Error(`saveProcess: step ${i + 1} is not a string`);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error(`saveProcess: step ${i + 1} is empty`);
    }
    if (trimmed.length > MAX_PROCESS_STEP_LEN) {
      throw new Error(
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
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[];
    }
    return [];
  } catch {
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
  assertTenantId('saveProcess', tenantId);
  if (!opts.processName || opts.processName.trim().length === 0) {
    throw new Error('saveProcess: processName is required');
  }
  const steps = validateProcessSteps(opts.steps);
  const isSupersede = opts.supersedesProcessId !== undefined;
  // change_summary is only meaningful on a supersession; NULL on a fresh create.
  const changeSummary = isSupersede ? (opts.changeSummary ?? null) : null;

  const now = new Date().toISOString();
  const content = buildProcessContent(opts.processName, steps, opts.description);
  const tags = ['process', ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'process',
    tenantId,
  });
  mem.half_life_days = PROCESS_HALF_LIFE_DAYS;

  let savedRow: ProcessRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Preflight the supersede target BEFORE inserting the new row. The new
      // row's autoincrement id could otherwise collide with a non-existent
      // supersedesProcessId (e.g. superseding id 1 on an empty store), making
      // the row supersede itself. Validating first means the new row is never a
      // candidate for its own supersede UPDATE. Mirrors saveDecision (codex P1
      // 2026-05-28). The same SELECT reads the predecessor version so the
      // successor's version is server-derived, never client-supplied.
      let version = 1;
      if (opts.supersedesProcessId !== undefined) {
        const pred = db.prepare(
          `SELECT status, version FROM processes WHERE id = ? AND tenant_id = ?`,
        ).get(opts.supersedesProcessId, tenantId) as
          | { status: string; version: number }
          | undefined;
        if (!pred) {
          throw new Error(
            `saveProcess: process ${opts.supersedesProcessId} to supersede not found for tenant ${tenantId}`,
          );
        }
        if (pred.status !== 'active') {
          throw new Error(
            `saveProcess: process ${opts.supersedesProcessId} is not active (status='${pred.status}'); only active processes can be superseded.`,
          );
        }
        version = pred.version + 1;
      }

      const result = db.prepare(`
        INSERT INTO processes(
          memory_id, tenant_id, process_name, description, steps, version,
          status, superseded_by, superseded_at, change_summary, closed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL, ?)
      `).run(
        memoryId,
        tenantId,
        opts.processName,
        opts.description ?? null,
        JSON.stringify(steps),
        version,
        changeSummary,
        now,
      );
      const processId = Number(result.lastInsertRowid ?? 0);

      if (opts.supersedesProcessId !== undefined) {
        const sup = db.prepare(`
          UPDATE processes
          SET status = 'superseded', superseded_by = ?, superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
        `).run(processId, now, opts.supersedesProcessId, tenantId, processId);
        if (sup.changes === 0) {
          throw new Error(
            `saveProcess: process ${opts.supersedesProcessId} could not be superseded (no longer active or self-reference).`,
          );
        }
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'process_supersede',
          targetId: String(opts.supersedesProcessId),
          metadata: {
            process_id: opts.supersedesProcessId,
            superseded_by: processId,
            new_version: version,
          },
        });
      }

      const row = db.prepare(`SELECT ${PROCESS_COLS} FROM processes WHERE id = ?`)
        .get(processId) as ProcessRow | undefined;
      if (!row) throw new Error('saveProcess: failed to reload saved process row');
      savedRow = row;

      // GDPR-light metadata: ids + counts only, no process_name / step text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'process_create',
        targetId: String(processId),
        metadata: {
          process_id: processId,
          version,
          step_count: steps.length,
          has_description: opts.description !== undefined && opts.description !== null && opts.description !== '',
        },
      });
    },
  });

  if (!savedRow) {
    throw new Error('saveProcess: afterWrite did not populate the row');
  }
  return rowToProcess(savedRow);
}

/**
 * Close (retire) an active process with no successor. Updates the processes row
 * only; the memory mirror is not mutated. CAS guard: WHERE status='active'; 0
 * changes distinguishes not-found from not-active. A superseded row is already
 * terminal in the chain and cannot be closed.
 */
export function closeProcess(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Process {
  assertTenantId('closeProcess', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE processes
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'active'
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM processes WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeProcess: process ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeProcess: process ${id} is not active (status='${existing.status}'); only active processes can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${PROCESS_COLS} FROM processes WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as ProcessRow | undefined;
      if (!row) throw new Error(`closeProcess: process ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'process_close',
        targetId: String(id),
        metadata: { process_id: id },
      });

      db.exec('COMMIT');
      return rowToProcess(row);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function loadProcessById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Process | null {
  assertTenantId('loadProcessById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${PROCESS_COLS} FROM processes WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as ProcessRow | undefined;
    return row ? rowToProcess(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: ListProcessesOpts = {},
): Process[] {
  assertTenantId('loadProcesses', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    let rows: ProcessRow[];
    if (opts.status) {
      if (!VALID_PROCESS_STATES.has(opts.status)) {
        throw new Error(
          `loadProcesses: status must be one of ${Array.from(VALID_PROCESS_STATES).join('|')}; got ${opts.status}`,
        );
      }
      rows = db.prepare(`
        SELECT ${PROCESS_COLS} FROM processes
        WHERE tenant_id = ? AND status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.status, limit) as ProcessRow[];
    } else {
      rows = db.prepare(`
        SELECT ${PROCESS_COLS} FROM processes
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, limit) as ProcessRow[];
    }
    return rows.map(rowToProcess);
  } finally {
    closeHippoDb(db);
  }
}

export function loadActiveProcesses(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Process[] {
  return loadProcesses(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}
