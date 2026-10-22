// Root-keyed goals and predictions forms tests call; production code goes through the port or the handle-first forms.

import { CLI_ACTOR } from '../../../src/base/scope/actor.js';
import { sqliteStore } from '../../../src/store/sqlite/store.js';
import { onHandle } from '../../../src/store/sqlite/handles.js';
import { resolveTenantId } from '../../../src/surface/server/boot.js';
import type { CompleteGoalOpts, PushGoalOpts } from '../../../src/store/port/goals.js';
import * as goalsSql from '../../../src/store/sqlite/goals.js';
import * as predictionsSql from '../../../src/store/sqlite/predictions.js';
import type { KeysetPosition } from '../../../src/base/util/keyset.js';
import { DEFAULT_LIST_LIMIT } from '../../../src/base/util/limits.js';
import type { ActiveGoals, GetActiveGoalsOpts, Goal, PredictionBaserate } from '../../../src/store/port/types.js';
import type { Prediction, PredictionClose } from '../../../src/store/port/objects.js';
import type { ClosureState } from '../../../src/base/records/prediction.js';

export async function pushGoal(hippoRoot: string, opts: PushGoalOpts): Promise<Goal> {
  return await sqliteStore(hippoRoot).goals.push(opts.tenantId, opts);
}

export function activeGoalsWithPolicies(hippoRoot: string, opts: GetActiveGoalsOpts): ActiveGoals {
  return onHandle(hippoRoot, (db) => goalsSql.activeGoalsWithPolicies(db, opts));
}

export async function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOpts): Promise<void> {
  return await sqliteStore(hippoRoot).goals.complete(resolveTenantId({}), goalId, opts);
}

export async function suspendGoal(hippoRoot: string, goalId: string): Promise<void> {
  return await sqliteStore(hippoRoot).goals.suspend(resolveTenantId({}), goalId);
}

export async function resumeGoal(hippoRoot: string, goalId: string): Promise<void> {
  return await sqliteStore(hippoRoot).goals.resume(resolveTenantId({}), goalId);
}

export async function closePrediction(
  hippoRoot: string,
  tenantId: string,
  id: number,
  close: PredictionClose,
  actor: string = CLI_ACTOR,
): Promise<Prediction> {
  return await sqliteStore(hippoRoot).predictions.closePrediction(tenantId, id, close, actor);
}

export async function loadPredictionById(hippoRoot: string, tenantId: string, id: number): Promise<Prediction | null> {
  return await sqliteStore(hippoRoot).predictions.predictionById(tenantId, id);
}

export async function loadPredictionsByClass(
  hippoRoot: string,
  tenantId: string,
  classTag: string,
  opts: {
    closureState?: ClosureState;
    limit?: number;
    after?: KeysetPosition;
  } = {},
): Promise<Prediction[]> {
  const { closureState, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return await sqliteStore(hippoRoot).predictions.listPredictions(
    tenantId,
    closureState === undefined ? { classTag, limit, after } : { classTag, closureState, limit, after },
  );
}

export async function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Promise<Prediction[]> {
  return await sqliteStore(hippoRoot).predictions.listPredictions(tenantId, {
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
  return onHandle(hippoRoot, (db) =>
    predictionsSql.computePredictionBaserate(db, tenantId, classTag, actor, emitAudit),
  );
}

export async function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Promise<Prediction[]> {
  const { classTag, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return await sqliteStore(hippoRoot).predictions.listPredictions(tenantId, {
    classTag,
    closureState: 'open',
    limit,
    after,
  });
}
