// What a consolidation did, as data; the CLI and the /v1/sleep reply turn each event into its line.

/** The rank a rescued row held in its tenant's memory-value order. */
export interface RescueRank {
  readonly rank: number;
  readonly totalNonPinned: number;
  readonly tenantId: string;
  readonly keepN: number;
}

export type ConsolidateEvent =
  | { kind: 'dormant'; id: string; strength: number; threshold: number }
  | { kind: 'removed'; id: string; strength: number; threshold: number }
  | {
      kind: 'rescued';
      id: string;
      strength: number;
      threshold: number;
      rank: RescueRank | undefined;
    }
  | { kind: 'nonFiniteScores'; ids: readonly string[] }
  /** A model-backed pass failed or was refused; `message` is the failure's text, shown once per phase and message. */
  | { kind: 'passFailed'; phase: string; message: string }
  | { kind: 'dagSummaries'; created: number; factsLinked: number }
  | {
      kind: 'dagRebuild';
      rebuilt: number;
      refused: number;
      zeroChildSkipped: number;
      failed: number;
      /** The rebuild cap when it stopped the pass, else null. */
      cappedAt: number | null;
    }
  | { kind: 'dagProfiles'; profiles: number; l2sLinked: number }
  | { kind: 'retiredText'; id: string; successorId: string | null }
  | { kind: 'merged'; count: number; preview: string }
  | { kind: 'physics'; particles: number; shown: number; stored: number; avgVelocity: number }
  | { kind: 'ftsResynced'; indexedRows: number; memories: number }
  | { kind: 'halfLifeRescaled'; count: number; from: number; to: number }
  | { kind: 'halfLifeTyped'; count: number; from: number; to: number }
  | { kind: 'notRemoved'; id: string }
  | { kind: 'dormantExpired'; count: number; retentionDays: number }
  | { kind: 'conflictsDetected'; count: number }
  | { kind: 'rescueAuditFailed'; failures: number }
  | { kind: 'rescueAuditUnavailable'; rescues: number }
  | { kind: 'tracePromoted'; id: string; sessionId: string; outcome: string }
  | { kind: 'tracesPromoted'; count: number }
  | { kind: 'sessionSkippedMixedScope'; sessionId: string }
  | { kind: 'replayed'; ids: readonly string[] }
  /** A pass threw and was skipped; the sleep went on without it. */
  | { kind: 'phaseSkipped'; phase: string; message: string };
