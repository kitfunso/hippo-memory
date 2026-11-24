import type { ConsolidateEvent } from '../../domain/consolidate/events.js';

export type SleepEvent =
  | ConsolidateEvent
  | { kind: 'graphSnapshotFailed'; message: string }
  | { kind: 'graphDrainFailed'; message: string }
  | { kind: 'graphStaleOpsSkipped'; count: number }
  | { kind: 'graphExtractFailed'; message: string };
