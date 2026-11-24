import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import type { SavableDescriptor } from './descriptor.js';
import { capText, requireLine, requireText } from './fields.js';
import { listObjects, type ObjectSaveSite, saveObject } from './lifecycle.js';
import type { BriefReceipt, BriefStatus, ProjectBrief } from '../../base/records/object-types.js';
import type { ObjectListQuery, Objects } from '../../base/ports/store.js';

export type { BriefStatus, ProjectBrief } from '../../base/records/object-types.js';

export const VALID_BRIEF_STATES: ReadonlySet<BriefStatus> = new Set<BriefStatus>([
  'active',
  'superseded',
  'closed',
]);

/** Field caps (untrusted at the HTTP/SDK boundary). summary is a body, so a larger cap than the 4096 short-field
 *  convention. */
export const MAX_REPO_LEN = 256;
export const MAX_BRIEF_SUMMARY_LEN = 8192;
const MAX_BRIEF_RECEIPTS = 50;
const MAX_RECEIPT_HEADLINE_LEN = 200;

export interface SaveProjectBriefOptions {
  repo: string;
  summary: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE brief this new version supersedes. */
  supersedesBriefId?: number;
  /** Extra memory tags merged after ['project_brief']. */
  extraTags?: string[];
  /** Internal: set by refreshedBrief to the receipt count so audit metadata marks the write as an auto-refresh without
   *  a 4th audit op. Not part of the CLI/HTTP surface. */
  refreshReceiptCount?: number;
}

export interface ListProjectBriefsOptions {
  status?: BriefStatus;
  repo?: string;
  limit?: number;
  after?: KeysetPosition;
}

export const PROJECT_BRIEF: SavableDescriptor<'project_brief', SaveProjectBriefOptions> = {
  kind: 'project_brief',
  label: 'brief',
  plural: 'briefs',
  states: VALID_BRIEF_STATES,
  closableFrom: ['active'],
  draft(opts, now) {
    const repo = requireLine(opts.repo, MAX_REPO_LEN, 'repo');
    const summary = requireText(opts.summary, MAX_BRIEF_SUMMARY_LEN, 'summary');
    capText(opts.changeSummary, MAX_SHORT_FIELD_LEN, 'changeSummary');
    return {
      fields: { repo, summary, receiptCount: opts.refreshReceiptCount },
      content: buildBriefContent(repo, summary),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesBriefId,
      changeSummary: opts.changeSummary,
      at: now.toISOString(),
    };
  },
};

function buildBriefContent(repo: string, summary: string): string {
  return `${repo}\n\n${summary}`;
}

export function loadProjectBriefs(
  objects: Objects,
  tenantId: string,
  opts: ListProjectBriefsOptions = {},
): Promise<ProjectBrief[]> {
  return listObjects(objects, PROJECT_BRIEF, tenantId, {
    status: opts.status,
    filter: opts.repo,
    limit: opts.limit,
    after: opts.after,
  });
}

function newestActive(repo: string): ObjectListQuery<'project_brief'> {
  return { status: 'active', filter: repo, limit: 1 };
}

function receiptHeadline(content: string): string {
  const firstLine = (content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const trimmed = firstLine.trim();
  return truncateWithEllipsis(trimmed, MAX_RECEIPT_HEADLINE_LEN);
}

function receiptTag(normalizedRepo: string): string {
  return `path:${normalizedRepo.toLowerCase()}`;
}

function fitReceiptLines(receipts: readonly BriefReceipt[]): string[] {
  const buildReceiptLine = (r: BriefReceipt): string =>
    `- ${(r.created ?? '').slice(0, 10)} [${r.source}] ${receiptHeadline(r.content)}`;

  const receiptLines: string[] = [];
  if (receipts.length > 0) {
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

function renderBriefDigest(
  normalizedRepo: string,
  receiptCount: number,
  receiptLines: string[],
): string {
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
  let markdown = lines.join('\n');
  if (markdown.length > MAX_BRIEF_SUMMARY_LEN) {
    markdown = markdown.slice(0, MAX_BRIEF_SUMMARY_LEN);
  }
  return markdown;
}

/** Assemble the repo's recent receipts into a deterministic markdown digest and return it with the receipt count; never
 *  empty (summary is NOT NULL). The brief's own mirror (source='project_brief') is excluded; the quotes in the
 *  JSON-array LIKE are load-bearing (`hip` must not match `path:hippo`). */
export async function briefFromReceipts(
  objects: Objects,
  tenantId: string,
  repo: string,
): Promise<BriefDigest> {
  const normalizedRepo = requiredRepo('briefFromReceipts', { tenantId, repo });
  const receipts = await objects.briefReceipts(
    tenantId,
    receiptTag(normalizedRepo),
    MAX_BRIEF_RECEIPTS,
  );
  return briefDigest(normalizedRepo, receipts);
}

export interface BriefDigest {
  markdown: string;
  receiptCount: number;
}

function requiredRepo(
  fn: string,
  { tenantId, repo }: { readonly tenantId: string; readonly repo: string },
): string {
  assertTenantId(fn, tenantId);
  return requireLine(repo, MAX_REPO_LEN, 'repo');
}

function briefDigest(normalizedRepo: string, receipts: readonly BriefReceipt[]): BriefDigest {
  return {
    markdown: renderBriefDigest(normalizedRepo, receipts.length, fitReceiptLines(receipts)),
    receiptCount: receipts.length,
  };
}

function refreshWrite(
  normalizedRepo: string,
  digest: BriefDigest,
  active: ProjectBrief | null,
): SaveProjectBriefOptions {
  return {
    repo: normalizedRepo,
    summary: digest.markdown,
    changeSummary: active ? `auto-refresh from ${digest.receiptCount} receipt(s)` : undefined,
    supersedesBriefId: active ? active.id : undefined,
    refreshReceiptCount: digest.receiptCount,
    extraTags: [receiptTag(normalizedRepo)],
  };
}

/** Saves a new version of the repo's brief from its receipts. The receipts are read before the
 * save's transaction, so a receipt written in between shows in the next refresh. */
export async function refreshedBrief(
  objects: Objects,
  site: ObjectSaveSite,
  repo: string,
): Promise<ProjectBrief> {
  const normalizedRepo = requiredRepo('refreshedBrief', { tenantId: site.tenantId, repo });
  const digest = await briefFromReceipts(objects, site.tenantId, normalizedRepo);
  const [active = null] = await objects.listObjects(
    site.tenantId,
    'project_brief',
    newestActive(normalizedRepo),
  );
  return saveObject(objects, PROJECT_BRIEF, site, refreshWrite(normalizedRepo, digest, active));
}
