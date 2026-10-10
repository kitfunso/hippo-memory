// Project names for every front end: list them, fold one into another, and repair old tags; the store opens hippo.db and owns each transaction.
// SHORTCUT: hippo.db only, since the store port has no project calls; a projects group when a served store needs them.
import {
  listProjects, mergeProjects, repairOnceOnSleep, repairProjects, type MergeResult, type ProjectSummary, type RepairResult,
} from '../sharing/project-merge.js';
import { onProjectTags, type ProjectTagStore } from '../store/project-tags.js';
import type { Context } from './types.js';

export type { MergeResult, ProjectCollision, ProjectFold, ProjectSummary, RepairResult } from '../sharing/project-merge.js';

export interface MergeProjectNamesOpts {
  from: string;
  into: string;
  /** Plans in a transaction that rolls back: nothing is written, mirrors and backup included. */
  dryRun: boolean;
}

function onProjects<T>(ctx: Context, fn: (store: ProjectTagStore) => T): T {
  return onProjectTags({ hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, actor: ctx.actor.subject }, fn);
}

/** Live rows per project name in the caller's tenant, newest write first. */
export function listProjectNames(ctx: Context): ProjectSummary[] {
  return onProjects(ctx, listProjects);
}

/** Folds project `from` into `into`, backed up and audited as `ctx.actor`; throws on user-global, unknown or equal names. */
export function mergeProjectNames(ctx: Context, opts: MergeProjectNamesOpts): MergeResult {
  return onProjects(ctx, (store) => mergeProjects(store, opts));
}

/** Sets aside stray imports, folds renamed projects and re-tags sleep's user-global merges; a dry run only plans. */
export function repairProjectNames(ctx: Context, opts: { dryRun: boolean }): RepairResult {
  return onProjects(ctx, (store) => repairProjects(store, opts));
}

/** The repair sleep runs once per store; null when it already ran. */
export function repairProjectNamesOnce(ctx: Context): RepairResult | null {
  return onProjects(ctx, repairOnceOnSleep);
}
