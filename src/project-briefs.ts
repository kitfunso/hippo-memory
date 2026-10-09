/**
 * Project_brief first-class object.
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

import { BadRequestError } from './api-errors.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { onHandle } from './store/open.js';
import { assertTenantId } from './tenant.js';
import { scopeAdmitSql } from './recall-scope.js';
import type { KeysetPosition } from './keyset.js';
import { escapeLike } from './escape.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { checkText, requireLine } from './objects/fields.js';
import { assertObjectStatus, closeObjectOn, dropClosedObjectFromGraph, loadObjectByIdOn, loadObjectsOn, saveObject } from './objects/lifecycle.js';
import type { JsonObject } from './working-memory.js';

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
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

/** A receipt row gathered for the refresh assembler. */
interface ReceiptRow {
  id: string;
  created: string;
  source: string;
  content: string;
}

/** What one brief write stores, resolved before the write. */
interface BriefFields {
  readonly repo: string;
  readonly summary: string;
  /** Set only when refreshBrief wrote this version. */
  readonly receiptCount: number | undefined;
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
    // SAFETY: row.status is DB-constrained to BriefStatus values; every INSERT/
    // UPDATE in this file writes only the literal 'active' | 'superseded' | 'closed'.
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

/** Tells an auto-refresh from a manual write in the audit log without a fourth audit op. */
function refreshMeta(w: BriefFields): JsonObject {
  return w.receiptCount === undefined ? { refreshed: false } : { refreshed: true, receipt_count: w.receiptCount };
}

const BRIEF: SavableDescriptor<ProjectBrief, ProjectBriefRow, 'repo', BriefFields> = {
  table: 'project_briefs',
  cols: BRIEF_COLS,
  label: 'brief',
  plural: 'briefs',
  fn: { get: 'loadProjectBriefById', close: 'closeProjectBrief', list: 'loadProjectBriefs', save: 'saveProjectBrief' },
  states: VALID_BRIEF_STATES,
  closableFrom: ['active'],
  ops: { close: 'project_brief_close', create: 'project_brief_create', supersede: 'project_brief_supersede' },
  idKey: 'brief_id',
  graphType: 'project',
  listFilters: { repo: 'repo' },
  rowTo: rowToProjectBrief,
  source: 'project_brief',
  versioned: true,
  columns: ['repo', 'summary'],
  values: (w) => [w.repo, w.summary],
  // Ids and flags only, never the brief text.
  createMeta: (w, version) => ({ repo: w.repo, version, ...refreshMeta(w) }),
  supersedeMeta: refreshMeta,
};

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
  assertTenantId(BRIEF.fn.save, tenantId);
  // The repo becomes a path tag on the refresh match and a heading in the digest, so it must be one line.
  const repo = requireLine(opts.repo, MAX_REPO_LEN, {
    required: 'saveProjectBrief: repo is required',
    singleLine: 'saveProjectBrief: repo must be a single line (no newlines)',
    tooLong: `saveProjectBrief: repo exceeds the ${MAX_REPO_LEN}-char cap`,
  });
  checkText(opts.summary, MAX_BRIEF_SUMMARY_LEN, {
    required: 'saveProjectBrief: summary is required',
    tooLong: `saveProjectBrief: summary exceeds the ${MAX_BRIEF_SUMMARY_LEN}-char cap`,
  });
  checkText(opts.changeSummary, MAX_CHANGE_SUMMARY_LEN, {
    tooLong: `saveProjectBrief: changeSummary exceeds the ${MAX_CHANGE_SUMMARY_LEN}-char cap`,
  });
  return saveObject(hippoRoot, BRIEF, tenantId, {
    actor,
    now: new Date().toISOString(),
    fields: { repo, summary: opts.summary, receiptCount: opts.refreshReceiptCount },
    content: buildBriefContent(repo, opts.summary),
    tags: opts.extraTags ?? [],
    supersedesId: opts.supersedesBriefId,
    changeSummary: opts.changeSummary,
  });
}

/**
 * Close (retire) an active brief. A superseded row is terminal.
 */
export function closeProjectBrief(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): ProjectBrief {
  assertTenantId(BRIEF.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => {
    const closed = closeObjectOn(db, BRIEF, tenantId, id, { actor, now });
    dropClosedObjectFromGraph(hippoRoot, BRIEF, tenantId, closed);
    return closed;
  });
}

export function loadProjectBriefById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): ProjectBrief | null {
  assertTenantId(BRIEF.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, BRIEF, tenantId, id));
}

export function loadProjectBriefs(
  hippoRoot: string,
  tenantId: string,
  opts: ListProjectBriefsOpts = {},
): ProjectBrief[] {
  assertTenantId(BRIEF.fn.list, tenantId);
  assertObjectStatus(BRIEF, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, BRIEF, tenantId, opts));
}

/**
 * The repo's CURRENT active brief, or null. By convention there is one active brief
 * per (tenant, repo); if an operator created more than one (the DB does not prevent
 * it, consistent with every other first-class object), the MOST-RECENT active row wins.
 */
export function loadActiveBriefForRepo(
  hippoRoot: string,
  tenantId: string,
  repo: string,
): ProjectBrief | null {
  assertTenantId('loadActiveBriefForRepo', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: SELECT ${BRIEF_COLS} projects exactly the ProjectBriefRow
    // columns; .get() returns that row, or undefined when no active brief
    // exists for this tenant/repo.
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

/** Single-line headline for a receipt: first non-empty line, newline-stripped,
 *  truncated. Deterministic + safe for the markdown bullet list. */
function receiptHeadline(content: string): string {
  const firstLine = (content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > MAX_RECEIPT_HEADLINE_LEN
    ? `${trimmed.slice(0, MAX_RECEIPT_HEADLINE_LEN)}...`
    : trimmed;
}

/** The repo's receipt rows, newest first, capped at MAX_BRIEF_RECEIPTS. */
function loadBriefReceipts(hippoRoot: string, tenantId: string, normalizedRepo: string): ReceiptRow[] {
  const tag = `path:${normalizedRepo.toLowerCase()}`;
  const likeParam = `%"${escapeLike(tag)}"%`;
  const deny = scopeAdmitSql('');

  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: SELECT projects exactly id, created, source, content (the
    // ReceiptRow columns); .all() returns rows in that shape.
    return db.prepare(`
      SELECT id, created, source, content FROM memories
      WHERE tenant_id = ?
        AND source != 'project_brief'
        AND LOWER(tags_json) LIKE ? ESCAPE '\\'
        AND ${deny.sql}
      ORDER BY created DESC, id DESC
      LIMIT ?
    `).all(tenantId, likeParam, ...deny.params, MAX_BRIEF_RECEIPTS) as ReceiptRow[];
  } finally {
    closeHippoDb(db);
  }
}

// NOTE on ordering: the `id DESC` tiebreak is lexical on a random-ish memory id
// (e.g. `sem_<hex>`), NOT chronological — within the same `created` timestamp the
// order is stable-but-arbitrary, not insertion order. `created DESC` is the real
// recency ordering.
//
// Budget-aware assembly: the digest is the
// brief `summary`, which saveProjectBrief caps at MAX_BRIEF_SUMMARY_LEN. The
// receipt/headline caps (50 x ~200) could otherwise build an ~11KB body that the
// store then REJECTS, breaking refresh for inputs within the advertised caps. So
// include receipt lines newest-first only while they fit under the cap (reserving
// slack for the header + an omission footer), and note the omitted remainder.
function fitReceiptLines(receipts: ReceiptRow[]): string[] {
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
  return receiptLines;
}

function renderBriefDigest(normalizedRepo: string, receiptCount: number, receiptLines: string[]): string {
  const omitted = receiptCount - receiptLines.length;
  const lines: string[] = [];
  lines.push(`# Project Brief: ${normalizedRepo}`);
  lines.push('');
  lines.push(
    omitted > 0
      ? `_Auto-assembled from ${receiptLines.length} of ${receiptCount} receipt(s)._`
      : `_Auto-assembled from ${receiptCount} receipt(s)._`,
  );
  lines.push('');
  lines.push('## Recent receipts');
  lines.push('');
  if (receiptCount === 0) {
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
  return markdown;
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
) {
  assertTenantId('assembleBriefFromReceipts', tenantId);
  const normalizedRepo = (repo ?? '').trim();
  if (normalizedRepo.length === 0) {
    throw new BadRequestError('assembleBriefFromReceipts: repo is required');
  }
  const receipts = loadBriefReceipts(hippoRoot, tenantId, normalizedRepo);
  const markdown = renderBriefDigest(normalizedRepo, receipts.length, fitReceiptLines(receipts));
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
  if (normalizedRepo.length === 0) throw new BadRequestError('refreshBrief: repo is required');

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
      // it like the manual `brief new`/`supersede` paths do.
      // Safe vs self-recursion: assembleBriefFromReceipts excludes
      // source='project_brief', so the brief never becomes its own receipt.
      extraTags: [`path:${normalizedRepo.toLowerCase()}`],
    },
    actor,
  );
}
