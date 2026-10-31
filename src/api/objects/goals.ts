// The per-session goal stack that recall boosts: push, list, complete, suspend and resume.

import type { CompleteGoalOpts, Goal, PushGoalOpts } from '../../store/goals.js';
import { requireHostAdmin, type ContextWith } from '../types.js';

/** What a new goal carries; its tenant is always the caller's. */
export type GoalPushOpts = Omit<PushGoalOpts, 'tenantId'>;

/** Push a goal onto `sessionId`'s stack in the caller's tenant. */
export function goalPush(ctx: ContextWith<'goals'>, opts: GoalPushOpts): Promise<Goal> {
  return ctx.store.goals.push(ctx.tenantId, opts);
}

/** The caller's goals for `sessionId`: active ones, or every status when `all` is set. */
export async function goalList(
  ctx: ContextWith<'goals'>,
  opts: { sessionId: string; all: boolean },
): Promise<Goal[]> {
  if (opts.all) return ctx.store.goals.sessionGoals(ctx.tenantId, opts.sessionId);
  return (await ctx.store.activeGoals({ sessionId: opts.sessionId, tenantId: ctx.tenantId })).goals;
}

/** Complete a goal by id; a no-op for an unknown or already completed goal. Host admin only. */
export async function goalComplete(ctx: ContextWith<'goals'>, goalId: string, opts: CompleteGoalOpts): Promise<void> {
  // Goal ids are not tenant-scoped in the store, so acting on one by id reaches past the caller's tenant.
  requireHostAdmin(ctx, 'Completing a goal by id');
  await ctx.store.goals.complete(ctx.tenantId, goalId, opts);
}

/** Suspend an active goal by id. Host admin only. */
export async function goalSuspend(ctx: ContextWith<'goals'>, goalId: string): Promise<void> {
  requireHostAdmin(ctx, 'Suspending a goal by id');
  await ctx.store.goals.suspend(ctx.tenantId, goalId);
}

/** Resume a suspended goal by id, suspending the oldest active one past the depth cap. Host admin only. */
export async function goalResume(ctx: ContextWith<'goals'>, goalId: string): Promise<void> {
  requireHostAdmin(ctx, 'Resuming a goal by id');
  await ctx.store.goals.resume(ctx.tenantId, goalId);
}
