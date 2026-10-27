// What the delivery recorder watches: the candidates, the picks and the guarded observer methods.
import type { MemoryEntry } from '../base/memory/entry.js';
import { scoreOverlap } from '../base/rank/prompt-recall.js';
import { blockHash } from '../base/util/token-text.js';
import type {
  DeliveryPool,
  DeliveryRejectReason,
  DeliveryStage,
  DeliveryWriteStore,
} from '../base/session/delivery.js';
import type {
  DeliveryFacts,
  DeliveryObserver,
  DeliveryOutcomeInput,
  DeliveryRecorder,
} from './delivery-recorder.js';

export interface Candidate {
  id: string;
  sourceStore: DeliveryWriteStore;
  pool: DeliveryPool;
  stage: DeliveryStage | null;
  reason: DeliveryRejectReason | null;
  score: number | null;
  tokens: number | null;
}

export interface ObservedPick {
  entry: MemoryEntry;
  rank: number;
  score: number;
  tokens: number;
  sourceStore: DeliveryWriteStore;
  promptRecall: boolean;
}

export function storeOf(isGlobal: boolean | undefined): DeliveryWriteStore {
  return isGlobal === true ? 'global' : 'local';
}

/** Everything the observer methods write and build reads; one per recorder. */
export interface RecorderState {
  readonly candidates: Map<string, Candidate>;
  readonly picked: Map<string, ObservedPick>;
  readonly filtered: Set<string>;
  facts: DeliveryFacts | null;
  shown: number;
  dropped: number;
  disabledSeen: boolean;
  outcome: DeliveryOutcomeInput;
  queryHash: string | null;
  recallTraceId: number | null;
  failureId: number | null;
  broken: { readonly error: unknown; readonly message: string } | null;
  flushed: boolean;
}

export type Guard = (fn: () => void) => void;

interface Rejection {
  readonly stage: DeliveryStage;
  readonly reason: DeliveryRejectReason;
  readonly score: number | null;
  readonly tokens: number | null;
}

export function rejectId(state: RecorderState, id: string, rejection: Rejection): void {
  const { stage, reason, score, tokens } = rejection;
  const held = state.candidates.get(id);
  // First rejection wins; an id never offered is not a candidate of this call.
  if (!held || held.reason !== null) return;
  state.candidates.set(id, { ...held, stage, reason, score, tokens });
}

type CandidateMethods = Pick<
  DeliveryObserver,
  'qualityDropped' | 'offer' | 'reject' | 'dropMissing' | 'gated' | 'selected'
>;

function markQualityDropped(
  state: RecorderState,
  ...[id, isGlobal]: Parameters<DeliveryObserver['qualityDropped']>
): void {
  state.filtered.add(id);
  if (!state.candidates.has(id)) {
    state.candidates.set(id, {
      id,
      sourceStore: storeOf(isGlobal),
      pool: 'recent',
      stage: null,
      reason: null,
      score: null,
      tokens: null,
    });
  }
  rejectId(state, id, { stage: 'load', reason: 'quality', score: null, tokens: null });
}

function offerEntries(
  state: RecorderState,
  ...[entries, isGlobal, pool]: Parameters<DeliveryObserver['offer']>
): void {
  for (const e of entries) {
    const held = state.candidates.get(e.id);
    const wanted: DeliveryPool = pool ?? (e.pinned ? 'pin' : 'recent');
    // A loaded recent row the prompt-recall gate then judges belongs to that pool.
    const relabel =
      held !== undefined &&
      held.reason === null &&
      held.pool === 'recent' &&
      wanted === 'prompt-recall';
    if (held !== undefined && !relabel) continue;
    state.candidates.set(e.id, {
      id: e.id,
      sourceStore: storeOf(isGlobal),
      pool: wanted,
      stage: null,
      reason: null,
      score: null,
      tokens: null,
    });
  }
}

function rejectGated(
  state: RecorderState,
  ...[prompt, items, gate, kept]: Parameters<DeliveryObserver['gated']>
): void {
  const keptIds = new Set(kept.map((g) => g.item.id));
  for (const c of items) {
    if (keptIds.has(c.id)) continue;
    const { score, shared } = scoreOverlap(prompt, c.tokens, gate.metric);
    const cleared = score >= gate.threshold && shared >= gate.minShared;
    rejectId(state, c.id, {
      stage: 'gate',
      reason: cleared ? 'gate-max-items' : 'gate-below-threshold',
      score,
      tokens: null,
    });
  }
}

/** The candidate-tracking half of the observer, each method run through `guard`. */
export function candidateMethods(state: RecorderState, guard: Guard): CandidateMethods {
  return {
    qualityDropped: (...args) => guard(() => markQualityDropped(state, ...args)),
    offer: (...args) => guard(() => offerEntries(state, ...args)),
    reject: (e, { stage, reason, score, tokens }) =>
      guard(() =>
        rejectId(state, e.id, { stage, reason, score: score ?? null, tokens: tokens ?? null }),
      ),
    dropMissing: (before, after, stage, reason) =>
      guard(() => {
        const kept = new Set(after.map((e) => e.id));
        for (const e of before) {
          if (!kept.has(e.id)) rejectId(state, e.id, { stage, reason, score: null, tokens: null });
        }
      }),
    gated: (...args) => guard(() => rejectGated(state, ...args)),
    selected: (items) =>
      guard(() => {
        state.picked.clear();
        items.forEach((r, i) => {
          state.picked.set(r.entry.id, {
            entry: r.entry,
            rank: i + 1,
            score: r.score,
            tokens: r.tokens,
            sourceStore: storeOf(r.isGlobal),
            promptRecall: r.promptRecall === true,
          });
        });
      }),
  };
}

export function newRecorderState(): RecorderState {
  return {
    candidates: new Map(),
    picked: new Map(),
    filtered: new Set(),
    facts: null,
    shown: 0,
    dropped: 0,
    disabledSeen: false,
    outcome: { state: 'empty' },
    queryHash: null,
    recallTraceId: null,
    failureId: null,
    broken: null,
    flushed: false,
  };
}

type StateMethods = Pick<
  DeliveryRecorder,
  | 'facts'
  | 'sections'
  | 'watchAdmit'
  | 'filtered'
  | 'disabled'
  | 'queried'
  | 'traced'
  | 'delivered'
  | 'logged'
>;

function watchedAdmit(
  state: RecorderState,
  guard: Guard,
  admit: (e: MemoryEntry) => boolean,
): (e: MemoryEntry) => boolean {
  return (e) => {
    const ok = admit(e);
    if (!ok) {
      guard(() => {
        state.filtered.add(e.id);
      });
    }
    return ok;
  };
}

export function stateMethods(state: RecorderState, guard: Guard): StateMethods {
  return {
    facts: (f) =>
      guard(() => {
        state.facts = { ...f };
      }),
    sections: (s, d) =>
      guard(() => {
        state.shown = s;
        state.dropped = d;
      }),
    watchAdmit: (admit) => watchedAdmit(state, guard, admit),
    filtered: (id) =>
      guard(() => {
        state.filtered.add(id);
      }),
    disabled: () =>
      guard(() => {
        state.disabledSeen = true;
      }),
    queried: (query) =>
      guard(() => {
        state.queryHash = blockHash(query);
      }),
    traced: (traceId) =>
      guard(() => {
        state.recallTraceId = traceId;
      }),
    delivered: (o) =>
      guard(() => {
        state.outcome = { ...o };
      }),
    logged: (failureId) =>
      guard(() => {
        state.failureId = failureId;
      }),
  };
}
