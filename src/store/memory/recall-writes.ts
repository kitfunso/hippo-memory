// The in-memory end of a recall: the goal log and audit rows together, then the trace and the strengthen.
import { markRetrieved, strengthOptionsOf, type LossAversion } from '../../base/memory/memory.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { blockHash } from '../../base/util/token-text.js';
import type { RecallTraceInput, RecallWrites } from '../port/recall-writes.js';
import { logGoalRecalls } from './goals.js';
import { appendAudit, nextId, ownedRow } from './rows.js';
import type { MemoryTables } from './tables.js';

/** The query's hash and length, never its text, with each result ranked from 1. */
function writeTrace(t: MemoryTables, trace: RecallTraceInput): void {
  t.recallTraces.push({
    id: nextId(t, 'recall_traces'),
    ts: new Date().toISOString(),
    tenantId: trace.tenantId,
    sessionId: trace.sessionId ?? null,
    pipeline: trace.pipeline,
    explainMode: trace.explainMode === true,
    queryHash: blockHash(trace.query),
    queryLength: trace.query.length,
    results: trace.results.map((r, i) => ({ memoryId: r.memoryId, rank: i + 1, score: r.score })),
  });
}

/** Each id found once, in the asked tenant, moves as markRetrieved scores it from the row read before any update. */
function strengthen(t: MemoryTables, { ids, opts }: NonNullable<RecallWrites['strengthen']>, rules: LossAversion) {
  if (ids.length === 0 || opts.recallBoostAblated) return;
  const live = [...new Set(ids)].flatMap((id) => ownedRow(t.entries, opts.tenantId, id) ?? []);
  for (const entry of markRetrieved(live, undefined, strengthOptionsOf(rules))) t.entries.set(entry.id, entry);
}

/** The reply is already decided, so a failed trace or strengthen logs and the recall still resolves. */
function failSoft(write: () => void, what: string): void {
  try {
    write();
  } catch (error) {
    log.warn(`${what} (${errorMessage(error)})`, errorFields(error));
  }
}

export function finishRecallIn(t: MemoryTables, writes: RecallWrites, rules: LossAversion): void {
  logGoalRecalls(t, writes.goalLog);
  appendAudit(t, writes.audit);
  const { trace, strengthen: ids } = writes;
  if (trace) failSoft(() => writeTrace(t, trace), 'recall trace write failed');
  if (ids) failSoft(() => strengthen(t, ids, rules), 'retrieval stats not saved');
}
