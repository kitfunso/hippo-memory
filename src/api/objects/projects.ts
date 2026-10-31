// Project names for every front end: list them, fold one into another, and repair old tags; the
// store owns each transaction.
import {
  listProjects,
  mergeProjects,
  planProjectRepair,
  repairOnceOnSleep,
  repairProjects,
  type MergeResult,
  type ProjectSummary,
  type RepairResult,
  type StoreFolder,
} from '../../domain/sharing/project-merge.js';
import type { ProjectTagReads, ProjectTagScope } from '../../base/ports/store/project-tags.js';
import type { Machine } from '../../base/util/agent-homes.js';
import { sharedStoreOf } from '../types.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export type {
  MergeResult,
  ProjectCollision,
  ProjectSummary,
  RepairResult,
} from '../../domain/sharing/project-merge.js';
export type { ProjectFold } from '../../base/ports/store/project-tags.js';

export interface MergeProjectNamesOptions {
  from: string;
  into: string;
  /** Plans in a transaction that rolls back: nothing is written, mirrors and backup included. */
  dryRun: boolean;
}

/** A repair reads the store's folder as well as its rows. */
type RepairContext = HippoDbContext;

function scopeOf(ctx: HippoDbContext): ProjectTagScope {
  return { tenantId: ctx.tenantId, actor: ctx.actor.subject };
}

async function folderOf(ctx: RepairContext): Promise<StoreFolder> {
  if (ctx.reach?.isGlobal) return { isGlobal: true, machine: ctx.infra.machine };
  const { project } = await ctx.store.hippoDb.folderFiles.home();
  return { isGlobal: false, shared: sharedStoreOf(ctx), project };
}

/** The reads a project-name plan takes: the tier's project tags, and rows and audit from the
 * port. */
function tagReads(store: HippoDbContext['store']): ProjectTagReads {
  const { entriesWhere, auditLog } = store;
  return { projectTags: store.hippoDb.projectTags, entriesWhere, auditLog };
}

/** Live rows per project name in the caller's tenant, newest write first. */
export function projectNameList(ctx: HippoDbContext): Promise<ProjectSummary[]> {
  return listProjects(tagReads(ctx.store), ctx.tenantId);
}

/** Folds project `from` into `into`, backed up and audited as `ctx.actor`; rejects on
 * user-global, unknown or equal names. */
export function projectNameMerge(
  ctx: HippoDbContext,
  opts: MergeProjectNamesOptions,
): Promise<MergeResult> {
  return mergeProjects(ctx.store.hippoDb.projectTags, scopeOf(ctx), opts);
}

/** Sets aside stray imports, folds renamed projects and re-tags sleep's user-global merges; a
 * dry run only plans. */
export async function projectNameRepair(
  ctx: RepairContext,
  opts: { dryRun: boolean },
): Promise<RepairResult> {
  return repairProjects(tagReads(ctx.store), scopeOf(ctx), await folderOf(ctx), opts);
}

/** The repair sleep runs once per store; null when it already ran. */
export async function projectNameRepairOnce(ctx: RepairContext): Promise<RepairResult | null> {
  return repairOnceOnSleep(tagReads(ctx.store), scopeOf(ctx), await folderOf(ctx));
}

/** What a repair of the global store would change, read only so doctor takes no write lock. */
export function globalProjectRepairPlan(
  store: ProjectTagReads,
  tenantId: string,
  machine: Machine,
): Promise<Omit<RepairResult, 'backup'>> {
  return planProjectRepair(store, tenantId, { isGlobal: true, machine });
}
