// Option and result shapes for contextGet.

import type { TaskSnapshot, SessionEvent } from '../store/port/sessions.js';
import type { SessionHandoff } from '../base/session/handoff.js';
import type { MemoryEntry } from '../base/memory/memory.js';
import type { DeliveryObserver } from './delivery-recorder.js';
import type { AmbientState } from '../base/memory/ambient.js';
import type { ProjectRef } from '../base/scope/project-identity.js';

/**
 * Options for `contextGet`: a budget-bounded bundle of recalled memories, active task snapshot, handoff and recent
 * events.
 * Rendering opts (`format`, `framing`, `rendered`) and host-side opts (`auto`) stay in the CLI, whose print helpers are
 * shared.
 */
export interface ContextOptions {
  q?: string;
  /** Default 1500 tokens. */
  budget?: number;
  limit?: number;
  pinnedOnly?: boolean;
  scope?: string;
  /**
   * Envelope scope to match exactly, as in `recall`: admits that scope even when private, after the actor's scope
   * check.
   */
  exactScope?: string;
  /**
   * With `pinnedOnly`, also inject the N most recent writes that pass the quality floor (`isWorthSurfacing`); pinned
   * entries bypass it.
   * Filtering happens BEFORE the take-N, so asking for 5 gets 5 qualifying entries. Ignored when `pinnedOnly` is false.
   */
  includeRecent?: number;
  /**
   * Re-include other-project memories the origin partition excludes by default; they come back tagged `category:
   * 'cross-project'`.
   */
  crossProject?: boolean;
  /**
   * The active project for the origin partition ('' = not in a project): a name, or an identity whose rows may carry
   * its legacy folder name.
   * The surface names it (the CLI from its cwd, a route or hook from its caller), so the api reads no working folder.
   */
  currentProject: ProjectRef;
  /**
   * The calling session's id, stamped on this call's recall trace. When it strictly equals the active snapshot's
   * `session_id` the read is unbounded; otherwise the snapshot must pass the freshness bound. Absent
   * (undefined/null/'') never matches. Host-resolved, so this stays host-agnostic.
   */
  currentSessionId?: string | null;
  /** Raw hook-payload prompt; only the pinned-only branch reads it, gated on `pinnedInject.promptRecall`. */
  prompt?: string;
  /** What the budget pays for, from the caller that renders the block. Absent = the memory text alone. */
  cost?: ContextCost;
  /** @internal The CLI's delivery-ledger observer; it only reads, so selection is the same with or without it. */
  deliveryObserver?: DeliveryObserver;
  sharedStore?: true;
}

/** Budget prices in the text a caller prints, so the budget bounds what reaches the model. */
export interface ContextCost {
  /** Tokens of one entry as printed. */
  entry: (item: Pick<ContextResultEntry, 'entry' | 'isGlobal' | 'promptRecall' | 'origin' | 'category'>) => number;
  /** Tokens of the headers and footer the block can print at this budget, reserved before any entry. */
  fixed: (budget: number, can: { cross: boolean; promptRecall: boolean; ambient: boolean }) => number;
  /** Tokens of the sections printed ahead of the memories, each as printed. */
  snapshot: (s: TaskSnapshot) => number;
  handoff: (h: SessionHandoff) => number;
  trail: (events: SessionEvent[]) => number;
}

export interface ContextResultEntry {
  entry: MemoryEntry;
  score: number;
  /** What this entry cost the budget: its printed line under `ContextOptions.cost`, else its memory text. */
  tokens: number;
  isGlobal?: boolean;
  isFreshTail?: boolean;
  /** Admitted by the prompt-recall gate, not the recent-N backfill or a pin. */
  promptRecall?: boolean;
  /** v39: the entry's owning project ('' = user-global, null = legacy row). */
  origin?: string | null;
  /**
   * How the origin relates to the active project; 'cross-project' appears only when `crossProject` was set (or
   * isolation is disabled).
   */
  category?: 'project' | 'user-global' | 'cross-project';
}

export interface ContextResult {
  entries: ContextResultEntry[];
  tokens: number;
  activeSnapshot?: TaskSnapshot | null;
  sessionHandoff?: SessionHandoff | null;
  recentEvents?: SessionEvent[];
  /** The ambient landscape summary over every live row the read may see in the local and global stores, not just the
   * rows loaded. Present only when ambient config is on, the caller is not pinned-only, and an entry was returned.
   */
  ambientState?: AmbientState;
}
