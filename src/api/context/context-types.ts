import type { TaskSnapshot, SessionEvent } from '../../base/ports/store/sessions.js';
import type { SessionHandoff } from '../../base/session/handoff.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { DeliveryObserver } from '../delivery/delivery-recorder.js';
import type { AmbientState } from '../../base/memory/ambient.js';
import type { ProjectRef } from '../../base/scope/project-identity.js';

/** How another session's task snapshot and handoff print: whole, or as a continuity pointer. */
export type ContinuityMode = 'full' | 'pointer';

/**
 * Options for `contextGet`: a budget-bounded bundle of recalled memories, active task snapshot,
 * handoff and recent events. Rendering opts (`format`, `framing`, `rendered`) and host-side opts
 * (`auto`) stay in the CLI, whose print helpers are shared.
 */
export interface ContextOptions {
  q?: string;
  budget?: number;
  limit?: number;
  pinnedOnly?: boolean;
  scope?: string;
  exactScope?: string;
  includeRecent?: number;
  crossProject?: boolean;
  currentProject: ProjectRef;
  currentSessionId?: string | null;
  prompt?: string;
  continuity?: ContinuityMode;
  ownHandoffOnly?: boolean;
  cost?: ContextCost;
  deliveryObserver?: DeliveryObserver;
  sharedStore?: true;
}

/** Budget prices in the text a caller prints, so the budget bounds what reaches the model. */
export interface ContextCost {
  entry: (
    item: Pick<
      ContextResultEntry,
      'entry' | 'isGlobal' | 'promptRecall' | 'origin' | 'category'
    > & { userRule?: boolean },
  ) => number;
  fixed: (
    budget: number,
    can: { cross: boolean; promptRecall: boolean; ambient: boolean; userRule: boolean },
  ) => number;
  snapshot: (s: TaskSnapshot, mode: ContinuityMode) => number;
  handoff: (h: SessionHandoff, mode: ContinuityMode) => number;
  trail: (events: SessionEvent[]) => number;
}

export interface ContextResultEntry {
  entry: MemoryEntry;
  score: number;
  tokens: number;
  isGlobal?: boolean;
  isFreshTail?: boolean;
  promptRecall?: boolean;
  origin?: string | null;
  category?: 'project' | 'user-global' | 'cross-project';
}

export interface ContextResult {
  entries: ContextResultEntry[];
  tokens: number;
  activeSnapshot?: TaskSnapshot | null;
  sessionHandoff?: SessionHandoff | null;
  snapshotMode?: ContinuityMode;
  handoffMode?: ContinuityMode;
  recentEvents?: SessionEvent[];
  ambientState?: AmbientState;
}
