// The class base rate over closed predictions, and the audit row a read of it leaves.

import { median } from '../../base/util/stats.js';
import { BadRequestError } from '../../base/errors/api-errors.js';
import { type DatabaseSyncLike } from '../../db/index.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { appendAuditEvents } from './audit.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { plural } from '../../base/util/format.js';

/** One closed prediction as the baserate reads it: both values set. */
interface ClosedEstimate {
  readonly estimate: number;
  readonly actual: number;
}

function emptyBaserate(classTag: string): PredictionBaserate {
  const nulls = {
    meanEstimate: null,
    meanActual: null,
    meanRatio: null,
    p50Ratio: null,
    mae: null,
  };
  return { classTag, nClosed: 0, nRatioEligible: 0, summary: '', ...nulls };
}

/** A class's stats over its closed rows, summed in the order given. Every store computes them
 * here, so no two can disagree on the arithmetic. */
function predictionBaserateOf(
  classTag: string,
  rows: readonly ClosedEstimate[],
): PredictionBaserate {
  const nClosed = rows.length;
  if (nClosed === 0) return emptyBaserate(classTag);
  const ratios = rows.filter((r) => r.estimate > 0).map((r) => r.actual / r.estimate);
  const nRatioEligible = ratios.length;
  const mae = rows.reduce((s, r) => s + Math.abs(r.actual - r.estimate), 0) / nClosed;
  const meanRatio = nRatioEligible > 0 ? ratios.reduce((s, x) => s + x, 0) / nRatioEligible : null;
  const ratioPart =
    meanRatio !== null
      ? `averaged ${meanRatio.toFixed(2)}x actual`
      : 'no ratio-eligible rows (all estimates were 0)';
  return {
    classTag,
    nClosed,
    nRatioEligible,
    meanEstimate: rows.reduce((s, r) => s + r.estimate, 0) / nClosed,
    meanActual: rows.reduce((s, r) => s + r.actual, 0) / nClosed,
    meanRatio,
    p50Ratio: nRatioEligible > 0 ? median(ratios) : null,
    mae,
    summary: `Last ${plural(nClosed, 'estimate')} in class ${classTag} ${ratioPart} (MAE ${mae.toFixed(2)}).`,
  };
}

/** One closed prediction as the baserate reads it: both values set. */
// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface BaserateRow {
  estimate_value: number;
  actual_value: number;
}

/** Base-rate stats for closed predictions in a class (Lovallo-Kahneman inside-vs-outside view):
 * closure_state='closed' with estimate and actual non-null; closed-unknown and open are
 * excluded. Audit-emit is built in here, not at the 3 call sites, so callers cannot drift. */
export function computePredictionBaserate(
  db: DatabaseSyncLike,
  tenantId: string,
  classTag: string,
  actor: string = CLI_ACTOR,
  /** False skips the predict_baserate audit so that channel only records deliberate baserate calls, not every recall
   *  the planning-fallacy orchestrator inspects. */
  emitAudit: boolean = true,
): PredictionBaserate {
  assertTenantId('computePredictionBaserate', tenantId);
  if (!classTag) throw new BadRequestError('computePredictionBaserate: classTag is required');
  // Ordered by id because the float sums differ with row order, and another store must reach the
  // same figures.
  const rows = cachedStatement(
    db,
    `
    SELECT estimate_value, actual_value
    FROM predictions
    WHERE tenant_id = ?
      AND class_tag = ?
      AND closure_state = 'closed'
      AND estimate_value IS NOT NULL
      AND actual_value IS NOT NULL
    ORDER BY id
  `,
  ).all(tenantId, classTag) as BaserateRow[];

  const baserate = predictionBaserateOf(
    classTag,
    rows.map((r) => ({ estimate: r.estimate_value, actual: r.actual_value })),
  );
  // An empty class is audited too, since an agent probing one is a signal; the recall path passes
  // false and audits its own hint.
  if (emitAudit) auditBaserateRead(db, { tenantId, actor, classTag, nClosed: baserate.nClosed });
  return baserate;
}

/** Who read which class's base rate, and how many closed predictions it held. */
interface BaserateReadOptions {
  readonly tenantId: string;
  readonly actor: string;
  readonly classTag: string;
  readonly nClosed: number;
}

function auditBaserateRead(
  db: DatabaseSyncLike,
  { tenantId, actor, classTag, nClosed }: BaserateReadOptions,
): void {
  appendAuditEvents(db, [
    {
      tenantId,
      actor,
      op: 'predict_baserate',
      targetId: classTag,
      metadata: { class_tag: classTag, n_closed: nClosed },
    },
  ]);
}
