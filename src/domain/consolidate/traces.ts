import { MemoryEntry, Layer, createMemory, markRetrieved } from '../../base/memory/entry.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import type { SessionEvent } from '../../base/records/sessions.js';
import type { SleepBegin, UntracedSession } from '../../base/records/consolidation.js';
import { sampleForReplay } from './replay.js';
import { renderTraceContent } from './trace.js';
import { commonDerivationScope } from '../../base/scope/recall-scope.js';
import { log } from '../../base/util/log.js';
import { REPLAY_COUNT_DEFAULT, type SleepRun } from './run.js';
import { type JsonValue, isJsonString } from '../../base/util/json.js';
import { DAY_MS } from '../../base/util/time.js';

/** The sessions whose traces this sleep promotes: the caller's tenant's, completed within the
 * window, with no trace yet; none under dryRun or with auto-trace off. */
export function traceWindow(
  run: Pick<SleepRun, 'tenantId' | 'now' | 'dryRun' | 'config'>,
): SleepBegin['traces'] {
  if (run.dryRun || run.config.autoTraceCapture === false) return undefined;
  const windowDays = run.config.autoTraceWindowDays ?? 7;
  // Auto-trace runs for the caller's tenant alone; consolidating every tenant needs a per-tenant
  // loop on top of this.
  return { tenantId: run.tenantId, sinceMs: run.now.getTime() - windowDays * DAY_MS };
}

// 1.4. Auto-promote complete sessions to traces: each session `traceWindow` names (idempotent via
// source_session_id) is rendered as markdown and persisted as a Layer.Trace memory, which inherits
// decay, search and replay. The store read the sessions with their events at sleep begin,
// and one tombstone read covers every trace.
export async function promoteSessionTraces(
  run: SleepRun,
  sessions: readonly UntracedSession[],
): Promise<void> {
  const { result } = run;
  const built = sessions.flatMap((session) => sessionTrace(run, run.tenantId, session) ?? []);
  const rejected = await run.tombstones.rejectedAmong(
    run.tenantId,
    built.map(({ trace }) => rejectionDigest(trace.content)),
  );
  let tracesSkippedRejected = 0;
  for (const { trace, outcome, sessionId } of built) {
    if (rejected.has(rejectionDigest(trace.content))) {
      await auditRejectedTrace(run, trace, sessionId);
      tracesSkippedRejected++;
      continue;
    }
    run.pendingWrites.push(trace);
    run.survivors.push(trace);
    result.promotedTraces++;
    result.events.push({ kind: 'tracePromoted', id: trace.id, sessionId, outcome });
  }

  if (result.promotedTraces > 0) {
    result.events.push({ kind: 'tracesPromoted', count: result.promotedTraces });
  }
  if (tracesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${tracesSkippedRejected} auto-promoted trace(s) whose content matches a rejected value`,
    );
  }
}

type TraceOutcome = 'success' | 'failure' | 'partial';

/** The trace a completed session renders to, or null when it cannot be promoted. */
function sessionTrace(
  run: SleepRun,
  consolidationTenant: string,
  { sessionId, events }: UntracedSession,
): { trace: MemoryEntry; outcome: TraceOutcome; sessionId: string } | null {
  // A mixed-scope session would otherwise leak into one trace.
  const sessionScope = commonDerivationScope(events.map((e) => e.scope));
  if (!sessionScope.ok) {
    run.result.tracesSkippedMixedScope++;
    run.result.events.push({ kind: 'sessionSkippedMixedScope', sessionId });
    return null;
  }

  const ending = sessionEnding(events);
  if (!ending) return null;
  const { outcome, summary } = ending;

  const steps = events
    .filter((e) => e.eventType !== 'session_complete')
    .map((e) => ({ action: e.content, observation: '' }));

  const trace = createMemory(
    renderTraceContent({ task: summary, steps, outcome }),
    {
      layer: Layer.Trace,
      traceOutcome: outcome,
      sourceSessionId: sessionId,
      tags: ['auto-promoted'],
      source: 'auto-promote',
      scope: sessionScope.scope,
      // Same tenant as the window's no-trace check, or a non-default tenant's trace regenerates
      // every sleep.
      tenantId: consolidationTenant,
      baseHalfLifeDays: run.config.defaultHalfLifeDays,
    },
    run.now,
  );
  return { trace, outcome, sessionId };
}

/** The outcome and title a session's terminal event carries, or null when it has none or the
 * event is malformed. */
function sessionEnding(
  events: readonly SessionEvent[],
): { outcome: TraceOutcome; summary: string } | null {
  const completeEvent = events.find((e) => e.eventType === 'session_complete');
  if (!completeEvent) return null; // defence-in-depth; the store's untraced-session read filters already.

  const outcomeRaw = completeEvent.content;
  if (outcomeRaw !== 'success' && outcomeRaw !== 'failure' && outcomeRaw !== 'partial') {
    // Malformed terminal event — skip rather than crash the whole sleep.
    return null;
  }

  // SAFETY: session event metadata is a free-form Record<string, unknown> bag; summary is optional
  // and is only trusted once isJsonString below confirms it is actually a string.
  const summaryValue = completeEvent.metadata.summary as JsonValue;
  const summary = isJsonString(summaryValue) ? summaryValue : '(untitled)';
  return { outcome: outcomeRaw, summary };
}

// A tombstoned trace is left out; its refusal row names the session, and the digest it was refused
// under.
async function auditRejectedTrace(
  run: SleepRun,
  trace: MemoryEntry,
  sessionId: string,
): Promise<void> {
  const traceDigest = rejectionDigest(trace.content);
  const tombstone = await run.tombstones.find(trace.tenantId, traceDigest);
  await run.tombstones.auditOrCount({
    tenantId: trace.tenantId,
    actor: 'sleep',
    op: 'reject_refusal',
    metadata: {
      digest: traceDigest,
      reason: tombstone?.reason ?? null,
      sourceSessionId: sessionId,
    },
  });
}

// 1.5. Replay pass: rehearse high-value survivors by sampling N memories weighted by outcome,
// valence, under-rehearsal and idle time, then applying the `markRetrieved` strengthening, so
// important memories don't fade.
export async function replayPass(run: SleepRun): Promise<void> {
  const { survivors, now } = run;
  const replayCount = run.config.replay?.count ?? REPLAY_COUNT_DEFAULT;
  // EVAL-ONLY ablation (see ablation.ts): replay rehearsal is recall strengthening, so the
  // strengthen-off arm silences the whole pass; persisting unmutated entries anyway would still
  // refresh updated_at and mirrors.
  if (!(replayCount > 0 && survivors.size > 0 && run.strength.recallStrengthens)) return;
  const seed = Math.floor(now.getTime() / 1000) & 0xffffffff;
  const picked = await survivors.get(
    await sampleForReplay({
      survivors: survivors.rows(),
      count: replayCount,
      now,
      seed,
      model: run.strength,
    }),
  );
  if (picked.length === 0) return;
  const rehearsed = markRetrieved(picked, now, run.strength);
  // Update survivors in place so downstream passes see rehearsed state.
  await survivors.set(rehearsed);
  run.result.replayed = rehearsed.length;
  run.result.events.push({ kind: 'replayed', ids: rehearsed.map((e) => e.id) });
  if (!run.dryRun) {
    for (const r of rehearsed) run.pendingWrites.push(r);
  }
}
