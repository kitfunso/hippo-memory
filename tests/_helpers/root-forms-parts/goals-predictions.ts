// Root-keyed goals and predictions forms tests call; production code goes through the store port or the At forms.

import { CLI_ACTOR } from '../../../src/base/scope/actor.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { resolveTenantId } from '../../../src/surface/server/boot.js';
import type { CompleteGoalOpts, PushGoalOpts } from '../../../src/store/port/goals.js';
import { activeGoalsWithPoliciesAt } from '../../../src/store/sqlite/goals.js';
import { onHandle } from '../../../src/store/sqlite/handles.js';
import { computePredictionBaserateAt } from '../../../src/store/sqlite/predictions.js';
import type { KeysetPosition } from '../../../src/base/util/keyset.js';
import { DEFAULT_LIST_LIMIT } from '../../../src/base/util/limits.js';
import type { ActiveGoals, GetActiveGoalsOpts, Goal, PredictionBaserate } from '../../../src/store/port/types.js';
import type { Prediction, PredictionClose } from '../../../src/store/port/predictions.js';
import type { ClosureState } from '../../../src/base/records/prediction.js';

export function pushGoal(hippoRoot: string, opts: PushGoalOpts): Goal {
  return sqliteSyncStore(hippoRoot).goals.push(opts.tenantId, opts);
}

export function activeGoalsWithPolicies(hippoRoot: string, opts: GetActiveGoalsOpts): ActiveGoals {
  return onHandle(hippoRoot, (db) => activeGoalsWithPoliciesAt(db, opts));
}

export function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOpts): void {
  return sqliteSyncStore(hippoRoot).goals.complete(resolveTenantId({}), goalId, opts);
}

export function suspendGoal(hippoRoot: string, goalId: string): void {
  return sqliteSyncStore(hippoRoot).goals.suspend(resolveTenantId({}), goalId);
}

export function resumeGoal(hippoRoot: string, goalId: string): void {
  return sqliteSyncStore(hippoRoot).goals.resume(resolveTenantId({}), goalId);
}

export function closePrediction(
  hippoRoot: string,
  tenantId: string,
  id: number,
  close: PredictionClose,
  actor: string = CLI_ACTOR,
): Prediction {
  return sqliteSyncStore(hippoRoot).predictions.closePrediction(tenantId, id, close, actor);
}

export function loadPredictionById(hippoRoot: string, tenantId: string, id: number): Prediction | null {
  return sqliteSyncStore(hippoRoot).predictions.predictionById(tenantId, id);
}

export function loadPredictionsByClass(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  opts: { closureState?: ClosureState; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  const { closureState, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(
    tenantId,
    closureState === undefined ? { classTag, limit, after } : { classTag, closureState, limit, after },
  );
}

export function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(tenantId, {
    limit: opts.limit ?? DEFAULT_LIST_LIMIT,
    after: opts.after,
  });
}

export function computePredictionBaserate(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  actor: string = CLI_ACTOR,
  emitAudit: boolean = true,
): PredictionBaserate {
  return onHandle(hippoRoot, (db) => computePredictionBaserateAt(db, tenantId, classTag, actor, emitAudit));
}

export function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Prediction[] {
  const { classTag, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return sqliteSyncStore(hippoRoot).predictions.listPredictions(tenantId, {
    classTag,
    closureState: 'open',
    limit,
    after,
  });
}
