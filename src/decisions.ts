/**
 * E2 decision first-class object (docs/plans/2026-05-28-e2-decision-object.md).
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
 * unrepresentable. Mirrors the v0.31 predictions pattern (src/predictions.ts).
 *
 * Dual-write atomicity: `saveDecision` writes the memory + decisions row (and,
 * when superseding, the old row's UPDATE) inside writeEntry's SAVEPOINT
 * 'write_entry' (store.ts:1196) via the afterWrite hook, so a failure in any
 * step rolls all of them back. Pattern matches savePrediction (predictions.ts).
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, DECISION_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

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
 * half_life DECISION_HALF_LIFE_DAYS, content = "<text>\n\nContext: <context>"
 * when context is given (so existing recall output is unchanged).
 */
export function saveDecision(
  hippoRoot: string,
  tenantId: string,
  opts: SaveDecisionOpts,
  actor: string = 'cli',
): Decision {
  assertTenantId('saveDecision', tenantId);
  if (!opts.decisionText) throw new Error('saveDecision: decisionText is required');

  const now = new Date().toISOString();
  const content = opts.context
    ? `${opts.decisionText}\n\nContext: ${opts.context}`
    : opts.decisionText;
  const tags = ['decision', ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'decision',
    tenantId,
  });
  mem.half_life_days = DECISION_HALF_LIFE_DAYS;

  // Populated inside afterWrite so the INSERT, the supersede UPDATE, and the
  // memory write all share one SAVEPOINT.
  let savedRow: DecisionRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Preflight the supersede target BEFORE inserting the new row. The new
      // row's autoincrement id could otherwise collide with a non-existent
      // supersedesDecisionId (e.g. superseding id 1 on an empty store, where the
      // INSERT below would itself become id 1), making the row supersede itself.
      // Validating first means the new row is never a candidate for its own
      // supersede UPDATE. codex review 2026-05-28 (P1).
      if (opts.supersedesDecisionId !== undefined) {
        const pred = db.prepare(
          `SELECT status FROM decisions WHERE id = ? AND tenant_id = ?`,
        ).get(opts.supersedesDecisionId, tenantId) as { status: string } | undefined;
        if (!pred) {
          throw new Error(
            `saveDecision: decision ${opts.supersedesDecisionId} to supersede not found for tenant ${tenantId}`,
          );
        }
        if (pred.status !== 'active') {
          throw new Error(
            `saveDecision: decision ${opts.supersedesDecisionId} is not active (status='${pred.status}'); only active decisions can be superseded.`,
          );
        }
      }

      const result = db.prepare(`
        INSERT INTO decisions(
          memory_id, tenant_id, decision_text, context,
          status, superseded_by, superseded_at, closed_at, created_at
        ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)
      `).run(
        memoryId,
        tenantId,
        opts.decisionText,
        opts.context ?? null,
        now,
      );
      const decisionId = Number(result.lastInsertRowid ?? 0);

      // Supersede the (preflight-validated) prior active decision in the SAME
      // SAVEPOINT, atomic with the new row. The `id != decisionId` exclusion is
      // defense-in-depth against the self-match described above; combined with
      // the preflight, a 0-change here is unreachable in the single-writer txn.
      if (opts.supersedesDecisionId !== undefined) {
        const sup = db.prepare(`
          UPDATE decisions
          SET status = 'superseded', superseded_by = ?, superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
        `).run(decisionId, now, opts.supersedesDecisionId, tenantId, decisionId);
        if (sup.changes === 0) {
          throw new Error(
            `saveDecision: decision ${opts.supersedesDecisionId} could not be superseded (no longer active or self-reference).`,
          );
        }
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'decision_supersede',
          targetId: String(opts.supersedesDecisionId),
          metadata: {
            decision_id: opts.supersedesDecisionId,
            superseded_by: decisionId,
          },
        });
      }

      const row = db.prepare(`SELECT ${DECISION_COLS} FROM decisions WHERE id = ?`)
        .get(decisionId) as DecisionRow | undefined;
      if (!row) throw new Error('saveDecision: failed to reload saved decision row');
      savedRow = row;

      // GDPR-light metadata: id + flag only, no decision_text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'decision_create',
        targetId: String(decisionId),
        metadata: {
          decision_id: decisionId,
          has_context: opts.context !== undefined && opts.context !== null && opts.context !== '',
        },
      });
    },
  });

  if (!savedRow) {
    // Unreachable unless afterWrite threw first; defensive.
    throw new Error('saveDecision: afterWrite did not populate the row');
  }
  return rowToDecision(savedRow);
}

/**
 * Close (retire) an active decision with no successor. Updates the decisions
 * row only; the memory mirror is not mutated. CAS guard mirrors closePrediction
 * (predictions.ts): WHERE status='active'; 0 changes distinguishes not-found
 * from not-active so callers surface the right error.
 */
export function closeDecision(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Decision {
  assertTenantId('closeDecision', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE decisions
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'active'
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM decisions WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeDecision: decision ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeDecision: decision ${id} is not active (status='${existing.status}'); only active decisions can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${DECISION_COLS} FROM decisions WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as DecisionRow | undefined;
      if (!row) throw new Error(`closeDecision: decision ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'decision_close',
        targetId: String(id),
        metadata: { decision_id: id },
      });

      db.exec('COMMIT');
      return rowToDecision(row);
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

export function loadDecisionById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Decision | null {
  assertTenantId('loadDecisionById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${DECISION_COLS} FROM decisions WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadDecisions(
  hippoRoot: string,
  tenantId: string,
  opts: ListDecisionsOpts = {},
): Decision[] {
  assertTenantId('loadDecisions', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    let rows: DecisionRow[];
    if (opts.status) {
      if (!VALID_DECISION_STATES.has(opts.status)) {
        throw new Error(
          `loadDecisions: status must be one of ${Array.from(VALID_DECISION_STATES).join('|')}; got ${opts.status}`,
        );
      }
      rows = db.prepare(`
        SELECT ${DECISION_COLS} FROM decisions
        WHERE tenant_id = ? AND status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.status, limit) as DecisionRow[];
    } else {
      rows = db.prepare(`
        SELECT ${DECISION_COLS} FROM decisions
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, limit) as DecisionRow[];
    }
    return rows.map(rowToDecision);
  } finally {
    closeHippoDb(db);
  }
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
    const row = db.prepare(
      `SELECT id FROM decisions WHERE memory_id = ? AND tenant_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    ).get(memoryId, tenantId) as { id: number } | undefined;
    return row ? row.id : null;
  } finally {
    closeHippoDb(db);
  }
}
