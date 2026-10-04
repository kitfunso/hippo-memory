import { isRecallBoostAblated } from '../ablation.js';
import { MemoryEntry, Layer, createMemory, markRetrieved } from '../memory.js';
import { findPromotableSessions, traceExistsForSession, listSessionEvents } from '../store/sessions.js';
import { rejectionDigest, findRejectedValue } from '../rejection.js';
import { sampleForReplay } from '../replay.js';
import { renderTraceContent } from '../trace.js';
import { resolveTenantId } from '../tenant.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import { commonDerivationScope } from '../recall-scope.js';
import { log } from '../log.js';
import { REPLAY_COUNT_DEFAULT, type JsonValue, isJsonString, type SleepRun } from './run.js';

// -------------------------------------------------------------------------
// 1.4. Auto-promote complete sessions to traces
// -------------------------------------------------------------------------
//
// For each session within the configured window that has a `session_complete`
// event and no existing trace (idempotency via the source_session_id column),
// render the action sequence as markdown and persist a Layer.Trace memory.
// Traces inherit decay, search, replay, and physics from the base MemoryEntry.
export function promoteSessionTraces(run: SleepRun): void {
  const { result } = run;
  if (run.dryRun || run.config.autoTraceCapture === false) return;
  let tracesSkippedRejected = 0;
  const windowDays = run.config.autoTraceWindowDays ?? 7;
  const sinceMs = run.now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  // Auto-trace currently runs in a single-tenant context (the env-resolved
  // tenant for this process). Multi-tenant deployments that want
  // consolidation across all tenants need a per-tenant loop layered on top
  // of this — tracked in docs/plans/2026-05-02-continuity-tables-tenant-scope.md.
  const consolidationTenant = resolveTenantId({});
  const promotable = findPromotableSessions(run.hippoRoot, consolidationTenant, sinceMs);

  for (const session of promotable) {
    const built = sessionTrace(run, consolidationTenant, session.session_id);
    if (!built) continue;
    const { trace, outcome } = built;
    if (traceRejected(run, trace, session.session_id)) {
      tracesSkippedRejected++;
      continue;
    }

    run.pendingWrites.push(trace);
    run.survivors.push(trace);
    result.promotedTraces++;
    result.details.push(
      `  🧬 promoted trace ${trace.id} from session ${session.session_id} (${outcome})`
    );
  }

  if (result.promotedTraces > 0) {
    result.details.push(
      `  🧬 promoted ${result.promotedTraces} trace${result.promotedTraces === 1 ? '' : 's'} from completed session${result.promotedTraces === 1 ? '' : 's'}`
    );
  }
  if (tracesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${tracesSkippedRejected} auto-promoted trace(s) whose content matches a rejected value`,
    );
  }
}

type TraceOutcome = 'success' | 'failure' | 'partial';

/** The trace a completed session renders to, or null when it already has one or cannot be promoted. */
function sessionTrace(run: SleepRun, consolidationTenant: string, sessionId: string): { trace: MemoryEntry; outcome: TraceOutcome } | null {
  // Idempotency: skip if a trace for this session already exists.
  if (traceExistsForSession(run.hippoRoot, consolidationTenant, sessionId)) return null;

  const events = listSessionEvents(run.hippoRoot, consolidationTenant, {
    session_id: sessionId,
    limit: 1000,
  });

  // T7: a mixed-scope session would otherwise leak into one trace.
  const sessionScope = commonDerivationScope(events.map((e) => e.scope));
  if (!sessionScope.ok) {
    run.result.tracesSkippedMixedScope++;
    run.result.details.push(`  ⏭  skipped session ${sessionId}: events span mixed scopes`);
    return null;
  }

  const completeEvent = events.find((e) => e.event_type === 'session_complete');
  if (!completeEvent) return null; // defence-in-depth; findPromotableSessions filters already.

  const outcomeRaw = completeEvent.content;
  if (outcomeRaw !== 'success' && outcomeRaw !== 'failure' && outcomeRaw !== 'partial') {
    // Malformed terminal event — skip rather than crash the whole sleep.
    return null;
  }
  const outcome: TraceOutcome = outcomeRaw;

  const steps = events
    .filter((e) => e.event_type !== 'session_complete')
    .map((e) => ({ action: e.content, observation: '' }));

  // SAFETY: session event metadata is a free-form Record<string, unknown>
  // bag; summary is optional and is only trusted once isJsonString below
  // confirms it is actually a string.
  const summaryValue = completeEvent.metadata.summary as JsonValue;
  const summary = isJsonString(summaryValue) ? summaryValue : '(untitled)';

  const trace = createMemory(
    renderTraceContent({ task: summary, steps, outcome }),
    {
      layer: Layer.Trace,
      trace_outcome: outcome,
      source_session_id: sessionId,
      tags: ['auto-promoted'],
      source: 'auto-promote',
      scope: sessionScope.scope,
      // T1 fix (2026-08-15 hardening pass): stamp the trace into the SAME
      // tenant the traceExistsForSession idempotency check (above) runs
      // under. Before
      // this, createMemory omitted tenantId and the trace always landed
      // 'default' (memory.ts:535) while the idempotency check ran under
      // consolidationTenant — for any non-default tenant that check never
      // hit, and the trace regenerated every sleep.
      tenantId: consolidationTenant,
      baseHalfLifeDays: run.config.defaultHalfLifeDays,
    },
  );
  return { trace, outcome };
}

// AT1 (same producer-side pattern as the merge pass below): traceExistsForSession
// only sees rows CURRENTLY in the store — once a rejected trace is
// removed, that idempotency check no longer blocks regeneration, and
// this write would otherwise reach batchWriteAndDelete's guard bypass
// unchecked, resurrecting it every sleep. Check under THE ENTRY'S OWN
// stamped tenantId (read off `trace` after createMemory — never guess
// the tenant) + the built content's digest. A hit skips the push
// entirely: not counted as promoted, not added to survivors.
function traceRejected(run: SleepRun, trace: MemoryEntry, sessionId: string): boolean {
  const consolidateDb = run.getConsolidateDb();
  if (!consolidateDb) return false;
  const traceDigest = rejectionDigest(trace.content);
  const tombstone = findRejectedValue(consolidateDb, trace.tenantId, traceDigest);
  if (!tombstone) return false;
  try {
    appendAuditEvent(consolidateDb, {
      tenantId: trace.tenantId,
      actor: 'sleep',
      op: 'reject_refusal',
      metadata: {
        digest: traceDigest,
        reason: tombstone.reason,
        sourceSessionId: sessionId,
      },
    });
  } catch (error) {
    reportAuditWriteFailure('reject_refusal', String(error));
  }
  return true;
}

// -------------------------------------------------------------------------
// 1.5. Replay pass — rehearse high-value survivors
// -------------------------------------------------------------------------
//
// Biologically-inspired counterpart to hippocampal replay during slow-wave
// sleep: sample N memories weighted by outcome + valence + under-rehearsal
// + idle time, then apply the same retrieval-strengthening `markRetrieved`
// applies to real queries. Distinct from decay (removal), physics (motion),
// and merge (compression) — this is the "rehearse the important stuff so
// it doesn't fade" pass.
export function replayPass(run: SleepRun): void {
  const { survivors, now } = run;
  const replayCount = run.config.replay?.count ?? REPLAY_COUNT_DEFAULT;
  // EVAL-ONLY ablation (see ablation.ts): replay rehearsal IS recall
  // strengthening (same markRetrieved dynamics), so the strengthen-off arm
  // silences the whole pass - markRetrieved would return unmutated entries
  // and persisting them anyway would still refresh updated_at / mirrors.
  if (!(replayCount > 0 && survivors.length > 0 && !isRecallBoostAblated())) return;
  const seed = Math.floor(now.getTime() / 1000) & 0xffffffff;
  const picked = sampleForReplay(survivors, replayCount, now, seed);
  if (picked.length === 0) return;
  const rehearsed = markRetrieved(picked, now);
  const rehearsedById = new Map(rehearsed.map((e) => [e.id, e]));
  // Update survivors in place so downstream passes see rehearsed state.
  for (let i = 0; i < survivors.length; i++) {
    const replacement = rehearsedById.get(survivors[i].id);
    if (replacement) survivors[i] = replacement;
  }
  run.result.replayed = rehearsed.length;
  run.result.details.push(
    `  💭 replayed ${rehearsed.length} memor${rehearsed.length === 1 ? 'y' : 'ies'}: ` +
    rehearsed.map((e) => e.id).join(', ')
  );
  if (!run.dryRun) {
    for (const r of rehearsed) run.pendingWrites.push(r);
  }
}
