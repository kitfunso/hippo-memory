// What a session end writes, once for both adapters: the snapshot or transcript read it writes from, and the handoff it
// builds; each adapter loads the rows these read and stores the result.
import type { HandoffEvidence, HandoffOutcome, SessionHandoff } from '../../base/session/handoff.js';
import type { SessionEndHandoffRequest, TaskSnapshot } from '../port/sessions.js';

type Derived = Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'>;

/** The snapshot and evidence a session end writes from. */
export interface SessionEndSource {
  readonly snapshot: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep' | 'scope'>;
  readonly evidence: HandoffEvidence | null;
  /** Read from the transcript, so an in-place write may rewrite an earlier transcript read. */
  readonly fromTranscript: boolean;
}

function transcriptSource(
  existing: SessionHandoff | null,
  derived: Derived | null,
  evidence: HandoffEvidence | null,
): SessionEndSource | null {
  // Only an earlier transcript read gives way; `hippo handoff create` and unmarked older handoffs keep winning.
  if (!derived || (existing && existing.evidence?.derivedFrom !== 'transcript')) return null;
  // A retried session end reads the same transcript, so it must not add a second revision.
  const same =
    existing?.taskId === derived.task &&
    existing.summary === derived.summary &&
    existing.nextAction === derived.nextStep;
  if (existing && same) return null;
  const snapshot = { ...derived, scope: null };
  return { snapshot, evidence: { ...evidence, derivedFrom: 'transcript' }, fromTranscript: true };
}

/** The source given the key's active snapshot and the session's newest handoff; null when that handoff already covers
 * the session or no source is the session's. */
export function sessionEndSource(
  active: TaskSnapshot | null,
  existing: SessionHandoff | null,
  request: Pick<SessionEndHandoffRequest, 'sessionId' | 'evidence' | 'derived' | 'inPlace'>,
): SessionEndSource | null {
  const { sessionId, evidence, derived = null, inPlace } = request;
  // After every reply the transcript is newer than the last compaction's snapshot, which the open chat keeps for the
  // next one.
  const snapshotGivesWay = inPlace === true && derived !== null && active?.source === 'pre-compact';
  if (active && active.sessionId === sessionId && !snapshotGivesWay) {
    // Strict '>': a same-millisecond tie must not swallow the session's only write.
    if (existing && existing.updatedAt > active.updatedAt) return null;
    return { snapshot: active, evidence, fromTranscript: false };
  }
  return transcriptSource(existing, derived, evidence);
}

/** The handoff `source` writes. A same-task refresh carries forward the envelope fields nobody cleared; a scope
 * mismatch carries none, so private metadata never leaks into an unscoped envelope. */
export function sessionEndHandoff(
  sessionId: string,
  source: SessionEndSource,
  existing: SessionHandoff | null,
  outcome: HandoffOutcome | null,
): Omit<SessionHandoff, 'updatedAt'> {
  const { snapshot } = source;
  const carry =
    existing != null && existing.taskId === snapshot.task && (existing.scope ?? null) === (snapshot.scope ?? null);
  return {
    version: 1,
    sessionId,
    repoRoot: carry ? existing.repoRoot : undefined,
    taskId: snapshot.task,
    summary: snapshot.summary,
    nextAction: snapshot.nextStep,
    artifacts: carry ? existing.artifacts : [],
    scope: snapshot.scope,
    evidence: source.evidence,
    outcome,
    constraints: carry ? existing.constraints : undefined,
    targetRuntime: carry ? existing.targetRuntime : undefined,
    cardId: carry ? existing.cardId : undefined,
  };
}
