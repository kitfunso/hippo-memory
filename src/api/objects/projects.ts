// Project names for every front end: list them, fold one into another, and repair old tags; the store owns each
// transaction.
import {
  listProjects,
  mergeProjects,
  repairOnceOnSleep,
  repairProjects,
  type MergeResult,
  type ProjectSummary,
  type RepairResult,
  type StoreFolder,
} from '../../domain/sharing/project-merge.js';
import type { ProjectTagScope } from '../../store/port/project-tags.js';
import { sharedStoreOf, type ContextWith } from '../types.js';
import { infraOf } from '../infra.js';

export type {
  MergeResult,
  ProjectCollision,
  ProjectSummary,
  RepairResult,
} from '../../domain/sharing/project-merge.js';
export type { ProjectFold } from '../../store/port/project-tags.js';

export interface MergeProjectNamesOptions {
  from: string;
  into: string;
  /** Plans in a transaction that rolls back: nothing is written, mirrors and backup included. */
  dryRun: boolean;
}

/** A repair reads the store's folder as well as its rows. */
type RepairContext = ContextWith<'projectTags' | 'folderFiles'>;

function scopeOf(ctx: ContextWith<'projectTags'>): ProjectTagScope {
  return { tenantId: ctx.tenantId, actor: ctx.actor.subject };
}

async function folderOf(ctx: RepairContext): Promise<StoreFolder> {
  if (ctx.reach?.isGlobal) return { isGlobal: true, machine: infraOf(ctx).machine };
  const { project } = await ctx.store.folderFiles.home();
  return { isGlobal: false, shared: sharedStoreOf(ctx), project };
}

/** Live rows per project name in the caller's tenant, newest write first. */
export function projectNameList(ctx: ContextWith<'projectTags'>): Promise<ProjectSummary[]> {
  return listProjects(ctx.store.projectTags, ctx.tenantId);
}

/** Folds project `from` into `into`, backed up and audited as `ctx.actor`; rejects on user-global, unknown or equal
 * names. */
export function projectNameMerge(
  ctx: ContextWith<'projectTags'>,
  opts: MergeProjectNamesOptions,
): Promise<MergeResult> {
  return mergeProjects(ctx.store.projectTags, scopeOf(ctx), opts);
}

/** Sets aside stray imports, folds renamed projects and re-tags sleep's user-global merges; a dry run only plans. */
export async function projectNameRepair(ctx: RepairContext, opts: { dryRun: boolean }): Promise<RepairResult> {
  return repairProjects(ctx.store.projectTags, scopeOf(ctx), await folderOf(ctx), opts);
}

/** The repair sleep runs once per store; null when it already ran. */
export async function projectNameRepairOnce(ctx: RepairContext): Promise<RepairResult | null> {
  return repairOnceOnSleep(ctx.store.projectTags, scopeOf(ctx), await folderOf(ctx));
}
