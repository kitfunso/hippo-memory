// Option and result shapes for getContext.

import type { TaskSnapshot, SessionEvent } from '../store/rows.js';
import type { SessionHandoff } from '../handoff.js';
import type { MemoryEntry } from '../memory.js';
import type { DeliveryObserver } from '../delivery-recorder.js';
import type { AmbientState } from '../ambient.js';
import type { ProjectRef } from '../project-identity.js';

// ---------------------------------------------------------------------------
// getContext
// ---------------------------------------------------------------------------

/**
 * Options for `getContext` — assemble a budget-bounded context bundle
 * (recalled memories + active task snapshot + handoff + recent events).
 *
 * Named `getContext` (not `context`) to avoid collision with the `Context`
 * interface above and the ubiquitous `ctx: Context` convention. Follows the
 * existing `getEntry` naming pattern in store.ts.
 *
 * Rendering opts (`format`, `framing`, `rendered`) and host-side opts (`auto`) stay in the CLI,
 * because its print helpers are shared with `cmdRecall` / `cmdSnapshot` / `cmdHandoffShow`.
 */
export interface ContextOpts {
  q?: string;
  /** Default 1500 tokens. */
  budget?: number;
  limit?: number;
  pinnedOnly?: boolean;
  scope?: string;
  /** Envelope scope to match exactly, as in `recall`: admits that scope even when private, after the actor's scope check. */
  exactScope?: string;
  /** With `pinnedOnly`, also inject the N most recent writes that pass the
   *  quality floor (`isWorthSurfacing`). Filtering happens BEFORE
   *  the take-N, so a caller asking for 5 gets 5 qualifying entries rather
   *  than 5-minus-junk; pinned entries bypass the floor. Entries are only
   *  skipped for this read, never mutated or deleted. Ignored when
   *  `pinnedOnly` is false — no other path reads it. */
  includeRecent?: number;
  /** v39 memory scope isolation: re-include other-project memories that the
   *  origin partition excludes by default. They come back tagged
   *  `category: 'cross-project'` so renderers can demarcate them. */
  crossProject?: boolean;
  /** The active project for the origin partition ('' = not in a project): a
   *  name, or an identity whose rows may also carry its legacy folder name.
   *  Defaults to `resolveProjectIdentity(process.cwd())`; surfaces whose
   *  process cwd is not the caller's project (HTTP server) should pass it. */
  currentProject?: ProjectRef;
  /** The calling
   *  session's id. Stamped on this call's recall trace, and the owner-match input to
   *  `loadFreshActiveTaskSnapshot` — when it strictly equals the active
   *  snapshot's `session_id`, the read is unbounded (same-session
   *  continuity); otherwise the snapshot must pass the freshness bound to
   *  surface. Absent (undefined/null/'') never short-circuits as a match;
   *  it just means every snapshot goes through the age check. Host-resolved
   *  (stdin payload, HIPPO_SESSION_ID, else the host's session var) so this stays host-agnostic. */
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
  /** What this entry cost the budget: its printed line under `ContextOpts.cost`, else its memory text. */
  tokens: number;
  isGlobal?: boolean;
  isFreshTail?: boolean;
  /** Admitted by the prompt-recall gate, not the recent-N backfill or a pin. */
  promptRecall?: boolean;
  /** v39: the entry's owning project ('' = user-global, null = legacy row). */
  origin?: string | null;
  /** v39: how the origin relates to the active project. 'cross-project'
   *  entries only appear when ContextOpts.crossProject was set (or isolation
   *  is disabled). */
  category?: 'project' | 'user-global' | 'cross-project';
}

export interface ContextResult {
  entries: ContextResultEntry[];
  tokens: number;
  activeSnapshot?: TaskSnapshot | null;
  sessionHandoff?: SessionHandoff | null;
  recentEvents?: SessionEvent[];
  /** The ambient landscape summary over every live row the read may see in the local and global stores,
   *  not just the rows loaded. Present only when ambient config is on, the caller is not pinned-only, and an entry was returned. */
  ambientState?: AmbientState;
}
