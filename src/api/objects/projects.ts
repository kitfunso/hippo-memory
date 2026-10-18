// Project names for every front end: list them, fold one into another, and repair old tags; the store opens hippo.db
// and owns each transaction.
// SHORTCUT: hippo.db only, through localFiles; a served group when another store needs project calls.
import {
  listProjects,
  mergeProjects,
  repairOnceOnSleep,
  repairProjects,
  type MergeResult,
  type ProjectSummary,
  type RepairResult,
} from '../../sharing/project-merge.js';
import type { ProjectTagStore } from '../../store/port/project-tags.js';
import type { ContextWith } from '../types.js';

export type { MergeResult, ProjectCollision, ProjectSummary, RepairResult } from '../../sharing/project-merge.js';
export type { ProjectFold } from '../../agent-memories/project-folds.js';

type LocalContext = ContextWith<'localFiles'>;

export interface MergeProjectNamesOptions {
  from: string;
  into: string;
  /** Plans in a transaction that rolls back: nothing is written, mirrors and backup included. */
  dryRun: boolean;
}

function onProjects<T>(ctx: LocalContext, fn: (store: ProjectTagStore) => T): T {
  return ctx.store.localFiles.projectTags.on({ tenantId: ctx.tenantId, actor: ctx.actor.subject }, fn);
}

/** Live rows per project name in the caller's tenant, newest write first. */
export function listProjectNames(ctx: LocalContext): ProjectSummary[] {
  return onProjects(ctx, listProjects);
}

/**
 * Folds project `from` into `into`, backed up and audited as `ctx.actor`; throws on user-global, unknown or equal
 * names.
 */
export function mergeProjectNames(ctx: LocalContext, opts: MergeProjectNamesOptions): MergeResult {
  return onProjects(ctx, (store) => mergeProjects(store, opts));
}

/** Sets aside stray imports, folds renamed projects and re-tags sleep's user-global merges; a dry run only plans. */
export function repairProjectNames(ctx: LocalContext, opts: { dryRun: boolean }): RepairResult {
  return onProjects(ctx, (store) => repairProjects(store, opts));
}

/** The repair sleep runs once per store; null when it already ran. */
export function repairProjectNamesOnce(ctx: LocalContext): RepairResult | null {
  return onProjects(ctx, repairOnceOnSleep);
}
