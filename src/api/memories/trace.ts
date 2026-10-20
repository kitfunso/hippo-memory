// A trace: the ordered steps of one agent task and how it ended, stored as one trace-layer memory.

import { Layer } from '../../base/memory/memory.js';
import { renderTraceContent, type TraceRecord } from '../../domain/consolidate/trace.js';
import type { Context } from '../types.js';
import { remember } from './remember.js';

export { parseSteps } from '../../domain/consolidate/trace.js';

/** A finished task as its caller recorded it, with the session it ran in and where the record came from. */
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
    local: { layer: Layer.Trace, source: input.source, traceOutcome: outcome, sourceSessionId: input.sessionId },
  });
  return { id };
}
