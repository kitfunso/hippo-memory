// The per-session goal stack that recall boosts: push, list, complete, suspend and resume.

import { ForbiddenError } from '../api-errors.js';
import {
  completeGoal, getActiveGoals, getSessionGoals, pushGoal, resumeGoal, suspendGoal,
  type CompleteGoalOpts, type Goal, type PushGoalOpts,
} from '../store/goals.js';
import type { Context } from './types.js';

/** What a new goal carries; its tenant is always the caller's. */
export type GoalPushOpts = Omit<PushGoalOpts, 'tenantId'>;

/** Push a goal onto `sessionId`'s stack in the caller's tenant. */
export function goalPush(ctx: Context, opts: GoalPushOpts): Goal {
  return pushGoal(ctx.hippoRoot, { ...opts, tenantId: ctx.tenantId });
}

/** The caller's goals for `sessionId`: active ones, or every status when `all` is set. */
export function goalList(ctx: Context, opts: { sessionId: string; all: boolean }): Goal[] {
  const scope = { sessionId: opts.sessionId, tenantId: ctx.tenantId };
  return opts.all ? getSessionGoals(ctx.hippoRoot, scope) : getActiveGoals(ctx.hippoRoot, scope);
}

/** Complete a goal by id; a no-op for an unknown or already completed goal. Host admin only. */
export function goalComplete(ctx: Context, goalId: string, opts: CompleteGoalOpts): void {
  requireHostAdmin(ctx);
  completeGoal(ctx.hippoRoot, goalId, opts);
}

/** Suspend an active goal by id. Host admin only. */
export function goalSuspend(ctx: Context, goalId: string): void {
  requireHostAdmin(ctx);
  suspendGoal(ctx.hippoRoot, goalId);
}

/** Resume a suspended goal by id, suspending the oldest active one past the depth cap. Host admin only. */
export function goalResume(ctx: Context, goalId: string): void {
  requireHostAdmin(ctx);
  resumeGoal(ctx.hippoRoot, goalId);
}

// Goal ids are not tenant-scoped in the store, so acting on one by id is a cross-tenant power.
function requireHostAdmin(ctx: Context): void {
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('Only the host admin can change a goal by id');
}
