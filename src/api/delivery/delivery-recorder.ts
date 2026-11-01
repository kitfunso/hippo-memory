// In-memory observer for one call (a context call, a compaction boundary or a session end): what
// was considered, why each was rejected, what reached stdout. No DB access (the caller hands
// build()'s output to src/store/sqlite/ledger/delivery-ledger.ts); hashes, ids, counts and enums only, never
// text. The observer state is delivery-observation.ts; the event row it builds is delivery-event.ts.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { PromptRecallGate } from '../../base/rank/prompt-recall.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { Ledger } from '../../base/records/ledger.js';
import type {
  DeliveryBlockState,
  DeliveryEventInput,
  DeliveryEventType,
  DeliveryPool,
  DeliveryRejectReason,
  DeliveryRuntime,
  DeliveryStage,
  DeliveryWriteStore,
} from '../../base/session/delivery.js';
import {
  type RecorderState,
  type Guard,
  newRecorderState,
  candidateMethods,
  stateMethods,
} from './delivery-observation.js';
import { type PayloadFacts, readPayload, buildEvent } from './delivery-event.js';

export interface DeliveryFacts {
  projectName: string;
  budgetTokens: number;
  promptRecall: boolean;
}

/** The shape of a returned context entry the observer reads. */
export interface DeliverySelected {
  entry: MemoryEntry;
  score: number;
  tokens: number;
  isGlobal?: boolean;
  promptRecall?: boolean;
}

/** Where and why a candidate fell out, with its score and tokens when the stage knew them. */
export interface CandidateRejection {
  readonly stage: DeliveryStage;
  readonly reason: DeliveryRejectReason;
  readonly score?: number;
  readonly tokens?: number;
}

/** What contextGet reports while it selects. Every method only reads; none changes what is
 * selected. */
export interface DeliveryObserver {
  facts(facts: DeliveryFacts): void;
  sections(shown: number, dropped: number): void;
  /** Returns `admit`'s own answer unchanged and lets its throws through. */
  watchAdmit(admit: (e: MemoryEntry) => boolean): (e: MemoryEntry) => boolean;
  /** A store's ambient load refused the row with this id under the admission it was sent. */
  filtered(id: string): void;
  /**
   * The loader's quality floor dropped a row admit let through; with prompt recall on, eligibility
   * reports it instead.
   */
  qualityDropped(id: string, isGlobal: boolean): void;
  disabled(): void;
  /** No `pool` means pin or recent by the entry's own flag. */
  offer(entries: readonly MemoryEntry[], isGlobal: boolean, pool?: DeliveryPool): void;
  reject(entry: MemoryEntry, rejection: CandidateRejection): void;
  dropMissing(
    before: readonly MemoryEntry[],
    after: readonly MemoryEntry[],
    stage: DeliveryStage,
    reason: DeliveryRejectReason,
  ): void;
  gated(
    prompt: ReadonlySet<string>,
    candidates: readonly { id: string; tokens: ReadonlySet<string> }[],
    gate: PromptRecallGate,
    kept: readonly { item: { id: string } }[],
  ): void;
  selected(items: readonly DeliverySelected[]): void;
  /** A searching call's query, `*` for none; kept as its hash, the one the recall trace stores. */
  queried(query: string): void;
  /** The recall trace a call that returned rows wrote; null when the write failed or the store
   * answers no id. */
  traced(traceId: number | null): void;
}

/** What the renderer sent, reported once at its exit. */
export interface DeliveryOutcomeInput {
  state: DeliveryBlockState;
  staticHash?: string | null;
  recallHash?: string | null;
  /** The exact text the agent receives: the hook's additionalContext, or every stdout byte,
   * newline included. */
  emittedText?: string | null;
  /** The static block was skipped as unchanged, so its entries are reused, not sent. */
  staticReused?: boolean;
}

export interface DeliveryRecorder extends DeliveryObserver {
  readonly ledger: Ledger;
  delivered(outcome: DeliveryOutcomeInput): void;
  /** The failure log row id a `tool-failure` event links to; null when the log write threw. */
  logged(failureId: number | null): void;
  /** The event, built on the first call only; null after that or once broken. Throws on an
   * injected fault. */
  takeEvent(): DeliveryEventInput | null;
}

export interface DeliveryRecorderInit {
  /** The ledger the event is written to when no turn carries it. */
  ledger: Ledger;
  storeHash: string;
  writeStore: DeliveryWriteStore;
  tenantId: string;
  stdinText?: string;
  envSessionId?: string;
  /**
   * Set by the caller's runtime flag; Copilot payloads carry hook_event_name too, so inference
   * would say claude-code.
   */
  runtime?: DeliveryRuntime;
  /** Set by hooks that are not prompt or context calls; without it the payload's hook event
   * decides. */
  eventType?: DeliveryEventType;
  /** Makes this recorder throw at one stage; only tests set it, and no CLI flag or environment
   * variable reaches it. */
  fault?: DeliveryFault;
  now: Date;
}

export type DeliveryFault = 'observe' | 'build' | 'flush';

/** A recorder for one call; every observer method is guarded, and a throw marks it broken
 * instead of escaping. */
export function createDeliveryRecorder(init: DeliveryRecorderInit): DeliveryRecorder {
  const startedMs = Date.now();
  const ts = init.now.toISOString();
  const fault = init.fault ?? null;
  const payload = readPayload(init);
  const state = newRecorderState();

  const guard = guardFor(state, fault);
  const { qualityDropped, offer, reject, dropMissing, gated, selected } = candidateMethods(
    state,
    guard,
  );

  return {
    ledger: init.ledger,
    ...stateMethods(state, guard),
    qualityDropped,
    offer,
    reject,
    dropMissing,
    gated,
    selected,
    takeEvent: recorderTake({ init, payload, state, ts, startedMs }),
  };
}

interface RecorderTakeOptions {
  readonly init: DeliveryRecorderInit;
  readonly payload: PayloadFacts;
  readonly state: RecorderState;
  readonly ts: string;
  readonly startedMs: number;
}

function recorderTake({
  init,
  payload,
  state,
  ts,
  startedMs,
}: RecorderTakeOptions): DeliveryRecorder['takeEvent'] {
  const fault = init.fault ?? null;
  return () => {
    if (state.flushed) return null;
    state.flushed = true;
    if (state.broken !== null) {
      log.warn(
        `delivery ledger skipped: recorder failed: ${state.broken.message}`,
        errorFields(state.broken.error),
      );
      return null;
    }
    if (fault === 'build') throw new Error('injected build fault');
    const input = buildEvent({ init, payload, state, ts, startedMs });
    if (fault === 'flush') throw new Error('injected flush fault');
    return input;
  };
}

function guardFor(state: RecorderState, fault: DeliveryFault | null): Guard {
  return (fn) => {
    if (state.broken !== null) return;
    try {
      if (fault === 'observe') throw new Error('injected observe fault');
      fn();
    } catch (error) {
      state.broken = { error, message: errorMessage(error) };
    }
  };
}
