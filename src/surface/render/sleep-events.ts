// The lines `hippo sleep` and POST /v1/sleep show for what a sleep did; one place, so both
// read alike.
import type { SleepEvent } from '../../api/sleep/sleep-run.js';
import { plural } from '../../base/util/format.js';

const STRENGTH_DECIMALS = 4;

type EventOf<K extends SleepEvent['kind']> = Extract<SleepEvent, { kind: K }>;

const strengthNote = (e: { strength: number; threshold: number }): string =>
  `(strength ${e.strength.toFixed(STRENGTH_DECIMALS)} < ${e.threshold})`;

function rescuedLine(e: EventOf<'rescued'>): string {
  const { rank } = e;
  const rankNote = rank
    ? ` - rescued (rank ${rank.rank}/${rank.totalNonPinned} in tenant ${rank.tenantId}, top ${rank.keepN})`
    : ' - rescued';
  return `  🛟 ${e.id} ${strengthNote(e)}${rankNote}`;
}

function dagRebuildLine(e: EventOf<'dagRebuild'>): string {
  const parts: string[] = [];
  if (e.rebuilt > 0) parts.push(`${e.rebuilt} rebuilt`);
  if (e.refused > 0) parts.push(`${e.refused} refused`);
  if (e.zeroChildSkipped > 0) parts.push(`${e.zeroChildSkipped} zero-child-skipped`);
  if (e.failed > 0) parts.push(`${e.failed} failed`);
  if (e.cappedAt !== null) parts.push(`CAPPED@${e.cappedAt}`);
  return `  🌳 DAG rebuild: ${parts.join(', ')}`;
}

type DecayEvent = EventOf<
  | 'dormant'
  | 'removed'
  | 'rescued'
  | 'nonFiniteScores'
  | 'notRemoved'
  | 'dormantExpired'
  | 'conflictsDetected'
  | 'rescueAuditFailed'
  | 'rescueAuditUnavailable'
>;

function decayLine(event: DecayEvent, dryRun: boolean): string {
  switch (event.kind) {
    case 'dormant':
      return `  💤 dormant ${event.id} ${strengthNote(event)}`;
    case 'removed':
      return `  🗑  removed ${event.id} ${strengthNote(event)}`;
    case 'rescued':
      return rescuedLine(event);
    case 'nonFiniteScores':
      return (
        `  ⚠️ memory-value: skipped ${plural(event.ids.length, 'entry', 'entries')} ` +
        `with non-finite computed features (never rescued): ${event.ids.join(', ')}`
      );
    case 'notRemoved':
      return `  ↩  ${event.id} not removed: pinned or already gone before sleep saved`;
    case 'dormantExpired':
      return (
        `  ⌛ ${dryRun ? 'would expire' : 'expired'} ${event.count} dormant ` +
        `memor${event.count === 1 ? 'y' : 'ies'} older than ${event.retentionDays} days`
      );
    case 'conflictsDetected':
      return `  ⚠️ detected ${plural(event.count, 'memory conflict')}`;
    case 'rescueAuditFailed':
      return (
        `  ⚠️ memory-value: ${plural(event.failures, 'mv_rescue audit row')} ` +
        `failed to write (the rescue itself still landed)`
      );
    case 'rescueAuditUnavailable':
      return (
        `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
        `(${plural(event.rescues, 'rescue')} not audited)`
      );
  }
}

type PassEvent = EventOf<
  | 'passFailed'
  | 'dagSummaries'
  | 'dagRebuild'
  | 'dagProfiles'
  | 'retiredText'
  | 'merged'
  | 'ftsResynced'
  | 'halfLifeRescaled'
  | 'halfLifeTyped'
>;

function passLine(event: PassEvent, dryRun: boolean): string {
  const moved = dryRun ? 'would move' : 'moved';
  switch (event.kind) {
    case 'passFailed':
      return `  ⚠️ ${event.phase}: ${event.message}`;
    case 'dagSummaries':
      return `  🌳 DAG: ${event.created} summaries created, ${event.factsLinked} facts linked`;
    case 'dagRebuild':
      return dagRebuildLine(event);
    case 'dagProfiles':
      return `  🌲 DAG L3: ${event.profiles} entity profiles, ${event.l2sLinked} L2s linked`;
    case 'retiredText': {
      const rest = event.successorId === null ? '' : `, ${event.successorId} holds the rest`;
      return `  ✂️  ${event.id} held a retired text${rest}`;
    }
    case 'merged':
      return `  🔀 merged ${event.count} episodic entries into semantic: "${event.preview}..."`;
    case 'ftsResynced':
      return (
        `  🔎 ${dryRun ? 'would re-sync' : 're-synced'} the full-text index (${event.indexedRows} indexed rows for ` +
        `${event.memories} memories)`
      );
    case 'halfLifeRescaled':
      return `  ⏳ ${moved} ${event.count} memories from the ${event.from}-day to the ${event.to}-day half-life`;
    case 'halfLifeTyped':
      return (
        `  ⏳ ${moved} ${event.count} memories of decisions, incidents and other objects ` +
        `from the ${event.from}-day to the ${event.to}-day half-life`
      );
  }
}

type TraceOrGraphEvent = EventOf<
  | 'tracePromoted'
  | 'tracesPromoted'
  | 'sessionSkippedMixedScope'
  | 'replayed'
  | 'graphSnapshotFailed'
  | 'graphDrainFailed'
  | 'graphStaleOpsSkipped'
  | 'graphExtractFailed'
>;

function traceOrGraphLine(event: TraceOrGraphEvent): string {
  switch (event.kind) {
    case 'tracePromoted':
      return `  🧬 promoted trace ${event.id} from session ${event.sessionId} (${event.outcome})`;
    case 'tracesPromoted':
      return `  🧬 promoted ${plural(event.count, 'trace')} from completed session${event.count === 1 ? '' : 's'}`;
    case 'sessionSkippedMixedScope':
      return `  ⏭  skipped session ${event.sessionId}: events span mixed scopes`;
    case 'replayed':
      return `  💭 replayed ${plural(event.ids.length, 'memory', 'memories')}: ${event.ids.join(', ')}`;
    case 'graphSnapshotFailed':
      return `graph: dirty-tenant snapshot failed (skipped graph refresh): ${event.message}`;
    case 'graphDrainFailed':
      return `graph: drain phase failed (skipped): ${event.message}`;
    case 'graphStaleOpsSkipped':
      return `graph: ${event.count} stale op(s) skipped for a tenant; the next sleep redoes them`;
    case 'graphExtractFailed':
      return `graph: extract failed for a dirty tenant (left pending): ${event.message}`;
  }
}

/** The line for one event; `dryRun` words the ones that say what was or would be done. */
export function sleepEventLine(event: SleepEvent, dryRun: boolean): string {
  switch (event.kind) {
    case 'dormant':
    case 'removed':
    case 'rescued':
    case 'nonFiniteScores':
    case 'notRemoved':
    case 'dormantExpired':
    case 'conflictsDetected':
    case 'rescueAuditFailed':
    case 'rescueAuditUnavailable':
      return decayLine(event, dryRun);
    case 'passFailed':
    case 'dagSummaries':
    case 'dagRebuild':
    case 'dagProfiles':
    case 'retiredText':
    case 'merged':
    case 'ftsResynced':
    case 'halfLifeRescaled':
    case 'halfLifeTyped':
      return passLine(event, dryRun);
    default:
      return traceOrGraphLine(event);
  }
}

/** The lines for a sleep's events, in the order they happened. */
export function sleepEventLines(events: readonly SleepEvent[], dryRun: boolean): string[] {
  return events.map((event) => sleepEventLine(event, dryRun));
}
