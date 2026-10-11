/** Project_brief object: the living, repo-scoped `summary` of a repository, evolving via supersession.
 *  `refreshBrief` assembles recent `path:<repo>` receipts with a deterministic (no-LLM) assembler; an LLM pipeline is deferred.
 *  The `project_briefs` table is the source of truth; the memory mirror (memory_id NULLABLE, ON DELETE SET NULL) is for recall. */

import { truncateWithEllipsis } from '../util/ellipsize.js';
import { BadRequestError } from '../core/api-errors.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { checkText, requireLine } from './fields.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, type ObjectSaveSite, saveObject, saveObjectAt } from './lifecycle.js';
import type { BriefReceipt, BriefStatus, ProjectBrief } from '../store/object-types.js';
import type { ObjectListQuery, Objects } from '../store/port.js';
import { sqliteObjects } from '../store/sqlite/objects-group.js';

export type { BriefStatus, ProjectBrief } from '../store/object-types.js';

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

export interface SaveProjectBriefOpts {
  repo: string;
  summary: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE brief this new version supersedes. */
  supersedesBriefId?: number;
  /** Extra memory tags merged after ['project_brief']. */
  extraTags?: string[];
  /** Internal: set by refreshBrief to the receipt count so audit metadata marks the write as an auto-refresh
   *  without a 4th audit op. Not part of the CLI/HTTP surface. */
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

export const PROJECT_BRIEF: SavableDescriptor<'project_brief', SaveProjectBriefOpts> = {
  kind: 'project_brief',
  label: 'brief',
  plural: 'briefs',
  fn: { get: 'loadProjectBriefById', close: 'closeProjectBrief', list: 'loadProjectBriefs', save: 'saveProjectBrief' },
  states: VALID_BRIEF_STATES,
  closableFrom: ['active'],
  draft(opts) {
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
    return {
      fields: { repo, summary: opts.summary, receiptCount: opts.refreshReceiptCount },
      content: buildBriefContent(repo, opts.summary),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesBriefId,
      changeSummary: opts.changeSummary,
      at: new Date().toISOString(),
    };
  },
};

/** Recall-surface content for the memory mirror: repo + summary. Named (mirrors
 *  buildSkillContent) so the recall surface is deterministic + unit-testable. */
function buildBriefContent(repo: string, summary: string): string {
  return `${repo}\n\n${summary}`;
}

/** Create a project_brief, or a new version superseding an existing one, in the `objects` store group's one transaction. */
export function saveProjectBrief(
  hippoRoot: string,
  tenantId: string,
  opts: SaveProjectBriefOpts,
  actor: string = 'cli',
): ProjectBrief {
  return saveObjectAt(PROJECT_BRIEF, { hippoRoot, tenantId, actor }, opts);
}

/** Close (retire) an active brief; a superseded row is terminal. */
export function closeProjectBrief(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): ProjectBrief {
  return closeObjectAt(hippoRoot, PROJECT_BRIEF, tenantId, id, actor);
}

export function loadProjectBriefById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): ProjectBrief | null {
  return objectByIdAt(hippoRoot, PROJECT_BRIEF, tenantId, id);
}

export function loadProjectBriefs(
  hippoRoot: string,
  tenantId: string,
  opts: ListProjectBriefsOpts = {},
): ProjectBrief[] {
  return listObjectsAt(hippoRoot, PROJECT_BRIEF, tenantId, { status: opts.status, filter: opts.repo, limit: opts.limit, after: opts.after });
}

/** The repo's current active brief, or null. The DB allows several active rows per (tenant, repo); the most recent wins. */
function loadActiveBriefForRepo(
  hippoRoot: string,
  tenantId: string,
  repo: string,
): ProjectBrief | null {
  assertTenantId('loadActiveBriefForRepo', tenantId);
  if (repo === '') return null;
  return sqliteObjects(hippoRoot).listObjects(tenantId, 'project_brief', newestActive(repo))[0] ?? null;
}

/** An empty filter lists every repo, so the callers refuse an empty repo first. */
function newestActive(repo: string): ObjectListQuery<'project_brief'> {
  return { status: 'active', filter: repo, limit: 1 };
}

/** Single-line headline for a receipt: first non-empty line, newline-stripped,
 *  truncated. Deterministic + safe for the markdown bullet list. */
function receiptHeadline(content: string): string {
  const firstLine = (content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return truncateWithEllipsis(trimmed, MAX_RECEIPT_HEADLINE_LEN);
}

/** The tag a memory of the repo carries; the store matches it whole, so `path:hip` never matches `path:hippo`. */
function receiptTag(normalizedRepo: string): string {
  return `path:${normalizedRepo.toLowerCase()}`;
}

// `id DESC` is a lexical tiebreak on a random-ish id, so same-`created` order is stable but arbitrary; `created DESC` is the recency order.
// Receipt lines go newest-first only while they fit MAX_BRIEF_SUMMARY_LEN (reserving slack for header and omission footer), else the store rejects the body.
function fitReceiptLines(receipts: readonly BriefReceipt[]): string[] {
  const buildReceiptLine = (r: BriefReceipt): string =>
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
  // Belt-and-suspenders: hard-clamp so the store's NOT-NULL/<=cap contract holds even for a single oversized line.
  let markdown = lines.join('\n');
  if (markdown.length > MAX_BRIEF_SUMMARY_LEN) {
    markdown = markdown.slice(0, MAX_BRIEF_SUMMARY_LEN);
  }
  return markdown;
}

/** Assemble the repo's recent receipts into a deterministic markdown digest and return it with the receipt count; never empty (summary is NOT NULL).
 *  The brief's own mirror (source='project_brief') is excluded; the quotes in the JSON-array LIKE are load-bearing (`hip` must not match `path:hippo`). */
export function assembleBriefFromReceipts(
  hippoRoot: string,
  tenantId: string,
  repo: string,
) {
  const normalizedRepo = requiredRepo('assembleBriefFromReceipts', tenantId, repo);
  return briefDigest(normalizedRepo, sqliteObjects(hippoRoot).briefReceipts(tenantId, receiptTag(normalizedRepo), MAX_BRIEF_RECEIPTS));
}

/** `assembleBriefFromReceipts` over a served store's group. */
export async function briefFromReceipts(objects: Objects, tenantId: string, repo: string): Promise<BriefDigest> {
  const normalizedRepo = requiredRepo('assembleBriefFromReceipts', tenantId, repo);
  return briefDigest(normalizedRepo, await objects.briefReceipts(tenantId, receiptTag(normalizedRepo), MAX_BRIEF_RECEIPTS));
}

export interface BriefDigest {
  markdown: string;
  receiptCount: number;
}

function requiredRepo(fn: string, tenantId: string, repo: string): string {
  assertTenantId(fn, tenantId);
  const normalizedRepo = (repo ?? '').trim();
  if (normalizedRepo.length === 0) throw new BadRequestError(`${fn}: repo is required`);
  return normalizedRepo;
}

function briefDigest(normalizedRepo: string, receipts: readonly BriefReceipt[]): BriefDigest {
  return { markdown: renderBriefDigest(normalizedRepo, receipts.length, fitReceiptLines(receipts)), receiptCount: receipts.length };
}

/** The version a refresh saves: a successor of the repo's active brief when it has one, else a first version. */
function refreshWrite(normalizedRepo: string, digest: BriefDigest, active: ProjectBrief | null): SaveProjectBriefOpts {
  return {
    repo: normalizedRepo,
    summary: digest.markdown,
    changeSummary: active ? `auto-refresh from ${digest.receiptCount} receipt(s)` : undefined,
    supersedesBriefId: active ? active.id : undefined,
    refreshReceiptCount: digest.receiptCount,
    // The path tag lets path-aware recall boost the brief; it cannot become its own receipt, because receipts leave out source project_brief.
    extraTags: [receiptTag(normalizedRepo)],
  };
}

/** Saves a new version of the repo's brief from its receipts. The receipts are read before
 * the save's transaction, so a receipt written in between shows in the next refresh. */
export function refreshBrief(
  hippoRoot: string,
  tenantId: string,
  repo: string,
  actor: string = 'cli',
): ProjectBrief {
  const normalizedRepo = requiredRepo('refreshBrief', tenantId, repo);
  const digest = assembleBriefFromReceipts(hippoRoot, tenantId, normalizedRepo);
  const active = loadActiveBriefForRepo(hippoRoot, tenantId, normalizedRepo);
  return saveProjectBrief(hippoRoot, tenantId, refreshWrite(normalizedRepo, digest, active), actor);
}

/** `refreshBrief` over a served store's group. */
export async function refreshedBrief(objects: Objects, site: ObjectSaveSite, repo: string): Promise<ProjectBrief> {
  const normalizedRepo = requiredRepo('refreshBrief', site.tenantId, repo);
  const digest = await briefFromReceipts(objects, site.tenantId, normalizedRepo);
  const [active = null] = await objects.listObjects(site.tenantId, 'project_brief', newestActive(normalizedRepo));
  return saveObject(objects, PROJECT_BRIEF, site, refreshWrite(normalizedRepo, digest, active));
}
