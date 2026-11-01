// What a sleep did beyond its consolidation, as data; the CLI and the /v1/sleep reply turn each
// event into its line.
import type { ConsolidateEvent } from '../../domain/consolidate/events.js';

export type SleepEvent =
  | ConsolidateEvent
  | { kind: 'graphSnapshotFailed'; message: string }
  | { kind: 'graphDrainFailed'; message: string }
  | { kind: 'graphStaleOpsSkipped'; count: number }
  | { kind: 'graphExtractFailed'; message: string };
