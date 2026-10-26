// A trace: the ordered steps of one agent task and how it ended, stored as one trace-layer memory.

import {
  calculateRewardFactor,
  calculateStrength,
  confidenceFacets,
  confidenceLabel,
} from '../../base/memory/strength.js';
import { Layer, type MemoryEntry } from '../../base/memory/entry.js';
import { DAY_MS } from '../../base/util/time.js';
import { renderTraceContent, type TraceRecord } from '../../domain/consolidate/trace.js';
import { strengthOf, type Context } from '../types.js';
import { remember } from './remember.js';

export { parseSteps } from '../../domain/consolidate/trace.js';

/** A finished task as its caller recorded it, with the session it ran in and where the record
 * came from. */
export interface TraceInput extends TraceRecord {
  readonly sessionId: string | null;
  readonly tags: string[];
  readonly source: string;
}

/** Stores the trace as one memory whose text lists the task, its outcome and each step. */
export async function traceRecord(ctx: Context, input: TraceInput): Promise<{ id: string }> {
  const { task, steps, outcome } = input;
  const { id } = await remember(ctx, {
    content: renderTraceContent({ task, steps, outcome }),
    tags: input.tags,
    local: {
      layer: Layer.Trace,
      source: input.source,
      traceOutcome: outcome,
      sourceSessionId: input.sessionId,
    },
  });
  return { id };
}

/** What `hippo trace <id>` shows of one row now: strength, half-life with and without its reward
 * factor, ages, the confidence reading and a projection of strength to later days. */
export function traceStats(entry: MemoryEntry, ctx: Pick<Context, 'infra' | 'config'>) {
  const now = ctx.infra.clock();
  const model = strengthOf(ctx);
  const strength = calculateStrength(entry, now, model);
  const halfLife = entry.halfLifeDays;
  const rewardFactor = calculateRewardFactor(entry, model);
  const effHalfLife = halfLife * rewardFactor;
  const createdMs = new Date(entry.created).getTime();
  const ageDays = (now.getTime() - createdMs) / DAY_MS;
  const lastMs = new Date(entry.lastRetrieved).getTime();
  const sinceLast = (now.getTime() - lastMs) / DAY_MS;
  const facets = confidenceFacets(entry, now);
  const conf = confidenceLabel(entry, now).text;

  // Projected strength: same decay curve, just push `now` out.
  const projectedAt = (days: number): number =>
    calculateStrength(entry, new Date(now.getTime() + days * DAY_MS), model);
  return {
    strength,
    halfLife,
    rewardFactor,
    effHalfLife,
    ageDays,
    sinceLast,
    facets,
    conf,
    projectedAt,
  };
}
