// Root-keyed goals and predictions forms tests call; production code goes through the port or the handle-first forms.

import { CLI_ACTOR } from '../../../src/base/records/audit-ops.js';
import { resolveTenantId } from '../../../src/surface/server/boot.js';
import type { CompleteGoalOptions, PushGoalOptions } from '../../../src/base/records/goals.js';
import * as goalsSql from '../../../src/store/sqlite/sessions/goals.js';
import * as baserateSql from '../../../src/store/sqlite/learning/prediction-baserate.js';
import type { KeysetPosition } from '../../../src/base/util/keyset.js';
import { DEFAULT_LIST_LIMIT } from '../../../src/base/util/limits.js';
import type {
  ActiveGoals,
  GetActiveGoalsOptions,
  Goal,
  PredictionBaserate,
} from '../../../src/base/ports/store/types.js';
import type { Prediction, PredictionClose } from '../../../src/base/records/objects.js';
import type { ClosureState } from '../../../src/base/records/prediction.js';
import { onHandle, sqliteStore } from '../test-session.js';

export async function pushGoal(hippoRoot: string, opts: PushGoalOptions): Promise<Goal> {
  return await sqliteStore(hippoRoot).hippoDb.goals.push(opts.tenantId, opts);
}

export function activeGoalsWithPolicies(hippoRoot: string, opts: GetActiveGoalsOptions): ActiveGoals {
  return onHandle(hippoRoot, (db) => goalsSql.activeGoalsWithPolicies(db, opts));
}

export async function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOptions): Promise<void> {
  return await sqliteStore(hippoRoot).hippoDb.goals.complete(resolveTenantId({}), goalId, opts);
}

export async function suspendGoal(hippoRoot: string, goalId: string): Promise<void> {
  return await sqliteStore(hippoRoot).hippoDb.goals.suspend(resolveTenantId({}), goalId);
}

export async function resumeGoal(hippoRoot: string, goalId: string): Promise<void> {
  return await sqliteStore(hippoRoot).hippoDb.goals.resume(resolveTenantId({}), goalId);
}

export async function closePrediction(
  hippoRoot: string,
  tenantId: string,
  id: number,
  close: Omit<PredictionClose, 'actor'>,
  actor: string = CLI_ACTOR,
): Promise<Prediction> {
  return await sqliteStore(hippoRoot).hippoDb.objects.closeObject(tenantId, 'prediction', id, { ...close, actor });
}

export async function loadPredictionById(hippoRoot: string, tenantId: string, id: number): Promise<Prediction | null> {
  return await sqliteStore(hippoRoot).hippoDb.objects.objectById(tenantId, 'prediction', id);
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
  return await sqliteStore(hippoRoot).hippoDb.objects.listObjects(
    tenantId,
    'prediction',
    closureState === undefined ? { classTag, limit, after } : { classTag, closureState, limit, after },
  );
}

export async function loadAllPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number; after?: KeysetPosition } = {},
): Promise<Prediction[]> {
  return await sqliteStore(hippoRoot).hippoDb.objects.listObjects(tenantId, 'prediction', {
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
  return onHandle(hippoRoot, (db) => baserateSql.computePredictionBaserate(db, tenantId, classTag, actor, emitAudit));
}

export async function loadOpenPredictions(
  hippoRoot: string,
  tenantId: string,
  opts: { classTag?: string; limit?: number; after?: KeysetPosition } = {},
): Promise<Prediction[]> {
  const { classTag, after } = opts;
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return await sqliteStore(hippoRoot).hippoDb.objects.listObjects(tenantId, 'prediction', {
    classTag,
    closureState: 'open',
    limit,
    after,
  });
}
