/**
 * E2 project_brief first-class object
 * (docs/plans/2026-05-30-e2-project-brief-object.md).
 *
 * A `project_brief` is the living, repo-scoped summary of a repository's state: a
 * `summary` body scoped to a `repo`, evolving via the supersede delta lifecycle.
 * "Auto-refreshes from receipts" is scoped to a DETERMINISTIC (no-LLM) assembler:
 * `refreshBrief` gathers the repo's recent receipts (memory rows tagged
 * `path:<repo>`) and assembles them into the brief body. The distinguishing
 * capability is therefore the refresh assembler (analog of skill's export
 * renderer), not an LLM/async pipeline (deferred).
 *
 * Reuses the skill/process supersede machinery verbatim (superseded_by self-FK +
 * CAS + INSERT-preflight + server-derived version + change_summary + supersede
 * tenant-match trigger). It DROPS skill's `skill_name`/`trigger_text` and ADDS
 * `repo` (the repo-scoping dimension) + `summary` (the brief body).
 *
 * The `project_briefs` table is the source of truth (survives memory decay); the
 * memory mirror is for recall. memory_id is NULLABLE with ON DELETE SET NULL.
 *
 * Lifecycle: active -> superseded (a newer version replaces it) or active ->
 * closed (retired).
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, PROJECT_BRIEF_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type BriefStatus = 'active' | 'superseded' | 'closed';

export const VALID_BRIEF_STATES: ReadonlySet<BriefStatus> = new Set<BriefStatus>([
  'active',
  'superseded',
  'closed',
]);

/** Field caps (untrusted at the HTTP/SDK boundary). summary is a body, so a larger
 *  cap than the 4096 short-field convention. */
export const MAX_REPO_LEN = 256;
export const MAX_BRIEF_SUMMARY_LEN = 8192;
export const MAX_CHANGE_SUMMARY_LEN = 4096;
/** Bound the receipts gathered per refresh (a refresh reads memories; cap the scan
 *  + the rendered body). Realistic repos have far fewer recent receipts than this. */
export const MAX_BRIEF_RECEIPTS = 50;
/** Truncate each receipt's headline in the assembled digest. */
export const MAX_RECEIPT_HEADLINE_LEN = 200;

export interface ProjectBrief {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion proceed without breaking
   *  the brief row. */
  memoryId: string | null;
  tenantId: string;
  /** The repo identifier this brief is scoped to (e.g. `hippo`). */
  repo: string;
  /** The brief body. */
  summary: string;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: BriefStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface SaveProjectBriefOpts {
  repo: string;
  summary: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE brief this new version supersedes. */
  supersedesBriefId?: number;
  /** Extra memory tags merged after ['project_brief']. */
  extraTags?: string[];
  /** Internal: set by refreshBrief to the receipt count so the audit metadata can
   *  mark the write as an auto-refresh (vs a manual supersede) WITHOUT a 4th audit
   *  op. Not part of the public CLI/HTTP surface. */
  refreshReceiptCount?: number;
}

export interface ListProjectBriefsOpts {
  status?: BriefStatus;
  /** Filter to a single repo. */
  repo?: string;
  limit?: number;
}

/** A receipt row gathered for the refresh assembler. */
interface ReceiptRow {
  id: string;
  created: string;
  source: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate + normalise brief fields. `repo` is trimmed and MUST be a single line
 * (no newlines): it becomes a path tag on the refresh match AND an H1 heading in
 * the assembled digest. `summary` is kept verbatim (operator content) but capped.
 * Returns the normalised repo.
 */
function validateBriefFields(
  repo: string,
  summary: string,
  changeSummary: string | undefined,
): { repo: string } {
  const normalizedRepo = (repo ?? '').trim();
  if (normalizedRepo.length === 0) throw new Error('saveProjectBrief: repo is required');
  if (/[\r\n]/.test(normalizedRepo)) {
    throw new Error('saveProjectBrief: repo must be a single line (no newlines)');
  }
  if (normalizedRepo.length > MAX_REPO_LEN) {
    throw new Error(`saveProjectBrief: repo exceeds the ${MAX_REPO_LEN}-char cap`);
  }
  if (!summary || summary.trim().length === 0) {
    throw new Error('saveProjectBrief: summary is required');
  }
  if (summary.length > MAX_BRIEF_SUMMARY_LEN) {
    throw new Error(`saveProjectBrief: summary exceeds the ${MAX_BRIEF_SUMMARY_LEN}-char cap`);
  }
  if (changeSummary !== undefined && changeSummary.length > MAX_CHANGE_SUMMARY_LEN) {
    throw new Error(`saveProjectBrief: changeSummary exceeds the ${MAX_CHANGE_SUMMARY_LEN}-char cap`);
  }
  return { repo: normalizedRepo };
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface ProjectBriefRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  repo: string;
  summary: string;
  version: number;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

function rowToProjectBrief(row: ProjectBriefRow): ProjectBrief {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    repo: row.repo,
    summary: row.summary,
    version: row.version,
    status: row.status as BriefStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    changeSummary: row.change_summary,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const BRIEF_COLS = `
  id, memory_id, tenant_id, repo, summary, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`;

/** Recall-surface content for the memory mirror: repo + summary. Named (mirrors
 *  buildSkillContent) so the recall surface is deterministic + unit-testable. */
function buildBriefContent(repo: string, summary: string): string {
  return `${repo}\n\n${summary}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a project_brief (or a new version that supersedes an existing one). Writes
 * the memory mirror + the project_briefs row atomically inside writeEntry's
 * SAVEPOINT. When supersedesBriefId is given, the referenced ACTIVE row is
 * preflighted (status + version) BEFORE the INSERT, then CAS-UPDATEd -> superseded
 * in the same SAVEPOINT; the new version = predecessor.version + 1 (server-derived).
 */
export function saveProjectBrief(
  hippoRoot: string,
  tenantId: string,
  opts: SaveProjectBriefOpts,
  actor: string = 'cli',
): ProjectBrief {
  assertTenantId('saveProjectBrief', tenantId);
  const { repo } = validateBriefFields(opts.repo, opts.summary, opts.changeSummary);
  const isSupersede = opts.supersedesBriefId !== undefined;
  const changeSummary = isSupersede ? (opts.changeSummary ?? null) : null;
  const isRefresh = opts.refreshReceiptCount !== undefined;

  const now = new Date().toISOString();
  const content = buildBriefContent(repo, opts.summary);
  const tags = ['project_brief', ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'project_brief',
    tenantId,
  });
  mem.half_life_days = PROJECT_BRIEF_HALF_LIFE_DAYS;

  let savedRow: ProjectBriefRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Preflight the supersede target BEFORE inserting the new row (so the new
      // autoincrement id can never be its own supersede target); read the
      // predecessor version in the same SELECT for server-derived versioning.
      // Mirrors saveSkill / saveProcess (codex P1 2026-05-28).
      let version = 1;
      if (opts.supersedesBriefId !== undefined) {
        const pred = db.prepare(
          `SELECT status, version FROM project_briefs WHERE id = ? AND tenant_id = ?`,
        ).get(opts.supersedesBriefId, tenantId) as
          | { status: string; version: number }
          | undefined;
        if (!pred) {
          throw new Error(
            `saveProjectBrief: brief ${opts.supersedesBriefId} to supersede not found for tenant ${tenantId}`,
          );
        }
        if (pred.status !== 'active') {
          throw new Error(
            `saveProjectBrief: brief ${opts.supersedesBriefId} is not active (status='${pred.status}'); only active briefs can be superseded.`,
          );
        }
        version = pred.version + 1;
      }

      const result = db.prepare(`
        INSERT INTO project_briefs(
          memory_id, tenant_id, repo, summary, version,
          status, superseded_by, superseded_at, change_summary, closed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL, ?)
      `).run(
        memoryId,
        tenantId,
        repo,
        opts.summary,
        version,
        changeSummary,
        now,
      );
      const briefId = Number(result.lastInsertRowid ?? 0);

      if (opts.supersedesBriefId !== undefined) {
        const sup = db.prepare(`
          UPDATE project_briefs
          SET status = 'superseded', superseded_by = ?, superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
        `).run(briefId, now, opts.supersedesBriefId, tenantId, briefId);
        if (sup.changes === 0) {
          throw new Error(
            `saveProjectBrief: brief ${opts.supersedesBriefId} could not be superseded (no longer active or self-reference).`,
          );
        }
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'project_brief_supersede',
          targetId: String(opts.supersedesBriefId),
          metadata: {
            brief_id: opts.supersedesBriefId,
            superseded_by: briefId,
            new_version: version,
            refreshed: isRefresh,
            ...(isRefresh ? { receipt_count: opts.refreshReceiptCount } : {}),
          },
        });
      }

      const row = db.prepare(`SELECT ${BRIEF_COLS} FROM project_briefs WHERE id = ?`)
        .get(briefId) as ProjectBriefRow | undefined;
      if (!row) throw new Error('saveProjectBrief: failed to reload saved brief row');
      savedRow = row;

      // GDPR-light metadata: ids + flags only, no brief text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'project_brief_create',
        targetId: String(briefId),
        metadata: {
          brief_id: briefId,
          repo,
          version,
          refreshed: isRefresh,
          ...(isRefresh ? { receipt_count: opts.refreshReceiptCount } : {}),
        },
      });
    },
  });

  if (!savedRow) {
    throw new Error('saveProjectBrief: afterWrite did not populate the row');
  }
  return rowToProjectBrief(savedRow);
}

/**
 * Close (retire) an active brief. CAS guard WHERE status='active'; 0 changes
 * distinguishes not-found from not-active. A superseded row is terminal.
 */
export function closeProjectBrief(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): ProjectBrief {
  assertTenantId('closeProjectBrief', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE project_briefs
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'active'
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM project_briefs WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeProjectBrief: brief ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeProjectBrief: brief ${id} is not active (status='${existing.status}'); only active briefs can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${BRIEF_COLS} FROM project_briefs WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as ProjectBriefRow | undefined;
      if (!row) throw new Error(`closeProjectBrief: brief ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'project_brief_close',
        targetId: String(id),
        metadata: { brief_id: id },
      });

      db.exec('COMMIT');
      return rowToProjectBrief(row);
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

export function loadProjectBriefById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): ProjectBrief | null {
  assertTenantId('loadProjectBriefById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${BRIEF_COLS} FROM project_briefs WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as ProjectBriefRow | undefined;
    return row ? rowToProjectBrief(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadProjectBriefs(
  hippoRoot: string,
  tenantId: string,
  opts: ListProjectBriefsOpts = {},
): ProjectBrief[] {
  assertTenantId('loadProjectBriefs', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.status && !VALID_BRIEF_STATES.has(opts.status)) {
    throw new Error(
      `loadProjectBriefs: status must be one of ${Array.from(VALID_BRIEF_STATES).join('|')}; got ${opts.status}`,
    );
  }
  const db = openHippoDb(hippoRoot);
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.repo) {
      clauses.push('repo = ?');
      params.push(opts.repo);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT ${BRIEF_COLS} FROM project_briefs
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as ProjectBriefRow[];
    return rows.map(rowToProjectBrief);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * The repo's CURRENT active brief, or null. By convention there is one active brief
 * per (tenant, repo); if an operator created more than one (the DB does not prevent
 * it, consistent with every other E2 object), the MOST-RECENT active row wins.
 */
export function loadActiveBriefForRepo(
  hippoRoot: string,
  tenantId: string,
  repo: string,
): ProjectBrief | null {
  assertTenantId('loadActiveBriefForRepo', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT ${BRIEF_COLS} FROM project_briefs
      WHERE tenant_id = ? AND repo = ? AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(tenantId, repo) as ProjectBriefRow | undefined;
    return row ? rowToProjectBrief(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Refresh assembler (the distinguishing deliverable)
// ---------------------------------------------------------------------------

/** Escape LIKE wildcards in operator-supplied text (mirror of store.ts:782). */
function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

/** Single-line headline for a receipt: first non-empty line, newline-stripped,
 *  truncated. Deterministic + safe for the markdown bullet list. */
function receiptHeadline(content: string): string {
  const firstLine = (content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > MAX_RECEIPT_HEADLINE_LEN
    ? `${trimmed.slice(0, MAX_RECEIPT_HEADLINE_LEN)}...`
    : trimmed;
}

/**
 * Assemble the repo's recent receipts into a deterministic markdown digest, and
 * return it WITH the receipt count (the count feeds refreshBrief's change_summary +
 * audit metadata). NO LLM. Always returns a non-empty, valid summary (a brief
 * `summary` is NOT NULL), including the zero-receipts case.
 *
 * A "receipt" = a tenant memory row carrying the repo's `path:<repo>` tag. The
 * brief's OWN memory mirror (source='project_brief') is excluded so a brief never
 * becomes its own receipt on the next refresh. The match is against the JSON-array
 * serialization (each element is a double-quoted string `"path:hippo"`); the
 * surrounding quotes are load-bearing — they stop `hip` matching `path:hippo`.
 * `repo` is LIKE-escaped + parameterized (operator-supplied; security.md).
 */
export function assembleBriefFromReceipts(
  hippoRoot: string,
  tenantId: string,
  repo: string,
): { markdown: string; receiptCount: number } {
  assertTenantId('assembleBriefFromReceipts', tenantId);
  const normalizedRepo = (repo ?? '').trim();
  if (normalizedRepo.length === 0) {
    throw new Error('assembleBriefFromReceipts: repo is required');
  }
  const tag = `path:${normalizedRepo.toLowerCase()}`;
  const likeParam = `%"${escapeLike(tag)}"%`;

  const db = openHippoDb(hippoRoot);
  let receipts: ReceiptRow[];
  try {
    receipts = db.prepare(`
      SELECT id, created, source, content FROM memories
      WHERE tenant_id = ?
        AND source != 'project_brief'
        AND LOWER(tags_json) LIKE ? ESCAPE '\\'
      ORDER BY created DESC, id DESC
      LIMIT ?
    `).all(tenantId, likeParam, MAX_BRIEF_RECEIPTS) as ReceiptRow[];
  } finally {
    closeHippoDb(db);
  }

  // NOTE on ordering: the `id DESC` tiebreak is lexical on a random-ish memory id
  // (e.g. `sem_<hex>`), NOT chronological — within the same `created` timestamp the
  // order is stable-but-arbitrary, not insertion order. `created DESC` is the real
  // recency ordering. (plan-eng-critic 2026-05-30, med.)
  //
  // Budget-aware assembly (codex-review-critic 2026-05-30, P2): the digest is the
  // brief `summary`, which saveProjectBrief caps at MAX_BRIEF_SUMMARY_LEN. The
  // receipt/headline caps (50 x ~200) could otherwise build an ~11KB body that the
  // store then REJECTS, breaking refresh for inputs within the advertised caps. So
  // include receipt lines newest-first only while they fit under the cap (reserving
  // slack for the header + an omission footer), and note the omitted remainder.
  const buildReceiptLine = (r: ReceiptRow): string =>
    `- ${(r.created ?? '').slice(0, 10)} [${r.source}] ${receiptHeadline(r.content)}`;

  const receiptLines: string[] = [];
  if (receipts.length > 0) {
    // Header + "## Recent receipts" + a worst-case omission footer cost; keep slack
    // so the joined markdown stays <= MAX_BRIEF_SUMMARY_LEN even after the footer.
    const SLACK = 400;
    let bodyBudget = MAX_BRIEF_SUMMARY_LEN - SLACK;
    for (const r of receipts) {
      const line = buildReceiptLine(r);
      if (line.length + 1 > bodyBudget) break;
      receiptLines.push(line);
      bodyBudget -= line.length + 1;
    }
  }
  const omitted = receipts.length - receiptLines.length;

  const lines: string[] = [];
  lines.push(`# Project Brief: ${normalizedRepo}`);
  lines.push('');
  lines.push(
    omitted > 0
      ? `_Auto-assembled from ${receiptLines.length} of ${receipts.length} receipt(s)._`
      : `_Auto-assembled from ${receipts.length} receipt(s)._`,
  );
  lines.push('');
  lines.push('## Recent receipts');
  lines.push('');
  if (receipts.length === 0) {
    lines.push(`_No receipts found for ${normalizedRepo}._`);
  } else {
    lines.push(...receiptLines);
    if (omitted > 0) {
      lines.push('');
      lines.push(`_... ${omitted} more receipt(s) omitted (summary cap)._`);
    }
  }
  // Belt-and-suspenders: the budget loop keeps us under the cap, but hard-clamp the
  // joined string so the store's NOT-NULL/<=cap contract can never be violated even
  // for a pathological single oversized line.
  let markdown = lines.join('\n');
  if (markdown.length > MAX_BRIEF_SUMMARY_LEN) {
    markdown = markdown.slice(0, MAX_BRIEF_SUMMARY_LEN);
  }
  return { markdown, receiptCount: receipts.length };
}

/**
 * Auto-refresh the repo's brief from its receipts: assemble the digest, then create
 * a new version. If the repo already has an active brief it is superseded (the
 * change_summary records the auto-refresh + the audit metadata carries
 * `refreshed: true`); otherwise a v1 is created. Returns the new brief.
 *
 * The assemble (a read of `memories`) happens BEFORE writeEntry opens its SAVEPOINT;
 * a concurrent receipt write landing between the read and the brief write simply
 * appears in the NEXT refresh — the brief is a derived snapshot, not a transactional
 * aggregate, so no consistency invariant is violated.
 */
export function refreshBrief(
  hippoRoot: string,
  tenantId: string,
  repo: string,
  actor: string = 'cli',
): ProjectBrief {
  assertTenantId('refreshBrief', tenantId);
  const normalizedRepo = (repo ?? '').trim();
  if (normalizedRepo.length === 0) throw new Error('refreshBrief: repo is required');

  const { markdown, receiptCount } = assembleBriefFromReceipts(hippoRoot, tenantId, normalizedRepo);
  const active = loadActiveBriefForRepo(hippoRoot, tenantId, normalizedRepo);

  return saveProjectBrief(
    hippoRoot,
    tenantId,
    {
      repo: normalizedRepo,
      summary: markdown,
      changeSummary: active ? `auto-refresh from ${receiptCount} receipt(s)` : undefined,
      supersedesBriefId: active ? active.id : undefined,
      refreshReceiptCount: receiptCount,
      // Tag the refreshed brief's mirror as repo-local so path-aware recall boosts
      // it like the manual `brief new`/`supersede` paths do (codex-review 2026-05-30,
      // P2). Safe vs self-recursion: assembleBriefFromReceipts excludes
      // source='project_brief', so the brief never becomes its own receipt.
      extraTags: [`path:${normalizedRepo.toLowerCase()}`],
    },
    actor,
  );
}
