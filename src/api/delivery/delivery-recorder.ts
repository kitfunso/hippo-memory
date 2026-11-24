import type { MemoryEntry } from '../../base/memory/entry.js';
import type { PromptRecallGate } from '../../base/rank/prompt-recall.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { Ledger } from '../../base/ports/store.js';
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
  watchAdmit(admit: (e: MemoryEntry) => boolean): (e: MemoryEntry) => boolean;
  filtered(id: string): void;
  qualityDropped(id: string, isGlobal: boolean): void;
  disabled(): void;
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
  queried(query: string): void;
  traced(traceId: number | null): void;
}

/** What the renderer sent, reported once at its exit. */
export interface DeliveryOutcomeInput {
  state: DeliveryBlockState;
  staticHash?: string | null;
  recallHash?: string | null;
  emittedText?: string | null;
  staticReused?: boolean;
}

export interface DeliveryRecorder extends DeliveryObserver {
  readonly ledger: Ledger;
  delivered(outcome: DeliveryOutcomeInput): void;
  logged(failureId: number | null): void;
  takeEvent(): DeliveryEventInput | null;
}

export interface DeliveryRecorderInit {
  ledger: Ledger;
  storeHash: string;
  writeStore: DeliveryWriteStore;
  tenantId: string;
  stdinText?: string;
  envSessionId?: string;
  runtime?: DeliveryRuntime;
  eventType?: DeliveryEventType;
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
