// In-memory observer for one hook call (a pinned-only context call or a compaction boundary): what was considered, why each was rejected, what reached stdout.
// No DB access (the caller hands build()'s output to src/recall-trace.ts); hashes, ids, counts and enums only, never text.
import type { MemoryEntry } from './memory.js';
import { evalNow } from './ablation.js';
import { scoreOverlap, type PromptRecallGate } from './prompt-recall.js';
import { blockHash, estimateTokens, hookPayloadSessionId, hookPayloadString, isSubagentPayload } from './token-ledger.js';
import { errorMessage } from './log.js';
export type DeliveryRuntime = 'claude-code' | 'codex' | 'copilot' | 'unknown';
export type DeliveryEventType = 'prompt-submit' | 'pinned-manual' | 'pre-compact' | 'compact-resume';
/** True for the two compaction boundary types. */
export const isBoundaryEvent = (type: DeliveryEventType): boolean => type === 'pre-compact' || type === 'compact-resume';
export type DeliverySurface = 'hook' | 'context';
export type DeliveryWriteStore = 'local' | 'global';
export type DeliverySessionState = 'payload' | 'env' | 'missing' | 'subagent';
export type DeliveryBlockState = 'sent' | 'reused' | 'reused-recall-sent' | 'empty' | 'disabled';
export type DeliveryPool = 'pin' | 'recent' | 'prompt-recall' | 'strength' | 'search';
export type DeliveryStage = 'load' | 'eligible' | 'gate' | 'budget' | 'limit' | 'final';
export type DeliveryOutcome = 'emitted' | 'reused' | 'rejected';
export type DeliveryRejectReason =
  | 'budget' | 'gate-below-threshold' | 'gate-max-items' | 'duplicate' | 'scope' | 'quality' | 'limit';

/** Row format version in `delivery_events.ledger_version`: 2 = written by a binary that can write boundary rows, so `event_type` has four values. */
export const DELIVERY_LEDGER_VERSION = 2;
/** Rejected candidate rows kept per event; the rest only add to `rejected_unlisted`. */
export const DELIVERY_REJECTED_ROW_CAP = 16;

// Deeper stages were closer to being sent, so the row cap keeps them first.
const STAGE_DEPTH: ReadonlyMap<DeliveryStage, number> = new Map<DeliveryStage, number>([
  ['load', 0], ['eligible', 1], ['gate', 2], ['budget', 3], ['limit', 4], ['final', 5],
]);

export interface DeliveryCandidateInput {
  memoryId: string;
  sourceStore: DeliveryWriteStore;
  pool: DeliveryPool;
  stage: DeliveryStage;
  outcome: DeliveryOutcome;
  reason: DeliveryRejectReason | null;
  rank: number | null;
  score: number | null;
  tokens: number | null;
}

/** One event as the writer stores it; the writer adds `turn_seq`, `duplicate_of` and the format version. */
export interface DeliveryEventInput {
  ts: string;
  tenantId: string;
  runtime: DeliveryRuntime;
  eventType: DeliveryEventType;
  surface: DeliverySurface;
  storeHash: string;
  writeStore: DeliveryWriteStore;
  projectHash: string | null;
  sessionId: string | null;
  sessionState: DeliverySessionState;
  hostTurnId: string | null;
  promptHash: string | null;
  promptLength: number;
  queryHash: string | null;
  recallTraceId: number | null;
  blockState: DeliveryBlockState;
  promptRecall: boolean;
  consideredCount: number;
  filteredCount: number;
  selectedCount: number;
  emittedCount: number;
  rejectedCount: number;
  rejectedUnlisted: number;
  sectionsShown: number;
  sectionsDropped: number;
  budgetTokens: number;
  selectedTokens: number;
  injectedTokens: number;
  staticHash: string | null;
  recallHash: string | null;
  emittedHash: string | null;
  elapsedMs: number;
  candidates: readonly DeliveryCandidateInput[];
}

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

/** What getContext reports while it selects. Every method only reads; none changes what is selected. */
export interface DeliveryObserver {
  facts(facts: DeliveryFacts): void;
  sections(shown: number, dropped: number): void;
  /** Returns `admit`'s own answer unchanged and lets its throws through. */
  watchAdmit(admit: (e: MemoryEntry) => boolean): (e: MemoryEntry) => boolean;
  /** The loader's quality floor dropped a row admit let through; with prompt recall on, eligibility reports it instead. */
  qualityDropped(entry: MemoryEntry, isGlobal: boolean): void;
  disabled(): void;
  /** No `pool` means pin or recent by the entry's own flag. */
  offer(entries: readonly MemoryEntry[], isGlobal: boolean, pool?: DeliveryPool): void;
  reject(entry: MemoryEntry, stage: DeliveryStage, reason: DeliveryRejectReason, score?: number, tokens?: number): void;
  dropMissing(before: readonly MemoryEntry[], after: readonly MemoryEntry[], stage: DeliveryStage, reason: DeliveryRejectReason): void;
  gated(
    prompt: ReadonlySet<string>,
    candidates: readonly { id: string; tokens: ReadonlySet<string> }[],
    gate: PromptRecallGate,
    kept: readonly { item: { id: string } }[],
  ): void;
  selected(items: readonly DeliverySelected[]): void;
}

/** What the renderer sent, reported once at its exit. */
export interface DeliveryOutcomeInput {
  state: DeliveryBlockState;
  staticHash?: string | null;
  recallHash?: string | null;
  /** The exact text the agent receives: the hook's additionalContext, or every stdout byte, newline included. */
  emittedText?: string | null;
  /** The static block was skipped as unchanged, so its entries are reused, not sent. */
  staticReused?: boolean;
}

export interface DeliveryRecorder extends DeliveryObserver {
  readonly root: string;
  delivered(outcome: DeliveryOutcomeInput): void;
  /** Builds the event and hands it to `write` once per call; throws on an injected fault, and writes nothing once broken. */
  flush(write: (input: DeliveryEventInput) => number | null): void;
}

export interface DeliveryRecorderInit {
  /** The store the event is written to. */
  root: string;
  storeHash: string;
  writeStore: DeliveryWriteStore;
  tenantId: string;
  stdinText?: string;
  envSessionId?: string;
  /** Set by the caller's runtime flag; Copilot payloads carry hook_event_name too, so inference would say claude-code. */
  runtime?: DeliveryRuntime;
  /** Set by hooks that are not prompt or context calls; without it the payload's hook event decides. */
  eventType?: DeliveryEventType;
}

interface Candidate {
  id: string;
  sourceStore: DeliveryWriteStore;
  pool: DeliveryPool;
  stage: DeliveryStage | null;
  reason: DeliveryRejectReason | null;
  score: number | null;
  tokens: number | null;
}

interface Picked {
  entry: MemoryEntry;
  rank: number;
  score: number;
  tokens: number;
  sourceStore: DeliveryWriteStore;
  promptRecall: boolean;
}

function storeOf(isGlobal: boolean | undefined): DeliveryWriteStore {
  return isGlobal === true ? 'global' : 'local';
}

function byDepthThenScore(a: Candidate, b: Candidate): number {
  const depth = (STAGE_DEPTH.get(b.stage ?? 'load') ?? 0) - (STAGE_DEPTH.get(a.stage ?? 'load') ?? 0);
  if (depth !== 0) return depth;
  const score = (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY);
  if (score !== 0 && !Number.isNaN(score)) return score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What the hook payload and env say about the call, read once at creation. */
interface PayloadFacts {
  payloadSession: string | null;
  envSession: string | null;
  prompt: string | null;
  hostTurnId: string | null;
  hookEvent: string | null;
  sessionState: DeliverySessionState;
}

/** Everything the observer methods write and build reads; one per recorder. */
interface RecorderState {
  readonly candidates: Map<string, Candidate>;
  readonly picked: Map<string, Picked>;
  readonly filtered: Set<string>;
  facts: DeliveryFacts | null;
  shown: number;
  dropped: number;
  disabledSeen: boolean;
  outcome: DeliveryOutcomeInput;
  broken: string | null;
  flushed: boolean;
}

type Guard = (fn: () => void) => void;

function readPayload(init: DeliveryRecorderInit): PayloadFacts {
  const payloadSession = hookPayloadSessionId(init.stdinText);
  const subagent = isSubagentPayload(init.stdinText);
  const envSession = init.envSessionId !== undefined && init.envSessionId !== '' ? init.envSessionId : null;
  const prompt = hookPayloadString(init.stdinText, 'prompt');
  const rawTurnId = hookPayloadString(init.stdinText, 'turn_id');
  const hostTurnId = rawTurnId !== null && rawTurnId.trim() !== '' ? rawTurnId : null;
  const hookEvent = hookPayloadString(init.stdinText, 'hook_event_name');
  const sessionState: DeliverySessionState = subagent
    ? 'subagent'
    : payloadSession !== null ? 'payload' : envSession !== null ? 'env' : 'missing';
  return { payloadSession, envSession, prompt, hostTurnId, hookEvent, sessionState };
}

interface Rejection {
  readonly stage: DeliveryStage;
  readonly reason: DeliveryRejectReason;
  readonly score: number | null;
  readonly tokens: number | null;
}

function rejectId(state: RecorderState, id: string, rejection: Rejection): void {
  const { stage, reason, score, tokens } = rejection;
  const held = state.candidates.get(id);
  // First rejection wins; an id never offered is not a candidate of this call.
  if (!held || held.reason !== null) return;
  state.candidates.set(id, { ...held, stage, reason, score, tokens });
}

function pickedRows(state: RecorderState): DeliveryCandidateInput[] {
  const staticReused = state.outcome.staticReused === true;
  const rows: DeliveryCandidateInput[] = [];
  for (const p of state.picked.values()) {
    const held = state.candidates.get(p.entry.id);
    rows.push({
      memoryId: p.entry.id,
      sourceStore: p.sourceStore,
      pool: p.promptRecall ? 'prompt-recall' : held?.pool === 'pin' || p.entry.pinned ? 'pin' : 'recent',
      stage: 'final',
      outcome: staticReused && !p.promptRecall ? 'reused' : 'emitted',
      reason: null,
      rank: p.rank,
      score: p.score,
      tokens: p.tokens,
    });
  }
  return rows;
}

interface RejectedRows {
  rows: DeliveryCandidateInput[];
  rejected: number;
  /** Offered but never judged. */
  undecided: number;
  overflow: number;
}

/** Rejected candidates deepest first, capped at DELIVERY_REJECTED_ROW_CAP rows. */
function rejectedRows(state: RecorderState): RejectedRows {
  const rejected: Candidate[] = [];
  let undecided = 0;
  for (const c of state.candidates.values()) {
    if (state.picked.has(c.id)) continue;
    if (c.reason === null) undecided += 1;
    else rejected.push(c);
  }
  rejected.sort(byDepthThenScore);
  const rows = rejected.slice(0, DELIVERY_REJECTED_ROW_CAP).map((c): DeliveryCandidateInput => ({
    memoryId: c.id, sourceStore: c.sourceStore, pool: c.pool, stage: c.stage ?? 'load', outcome: 'rejected',
    reason: c.reason, rank: null, score: c.score, tokens: c.tokens,
  }));
  const overflow = Math.max(0, rejected.length - DELIVERY_REJECTED_ROW_CAP);
  return { rows, rejected: rejected.length, undecided, overflow };
}

function buildEvent(
  init: DeliveryRecorderInit, payload: PayloadFacts, state: RecorderState, ts: string, startedMs: number,
): DeliveryEventInput {
  const { facts, outcome } = state;
  const picked = pickedRows(state);
  const rejected = rejectedRows(state);
  const rows = [...picked, ...rejected.rows];
  const emitted = outcome.emittedText ?? null;
  const eventType = init.eventType ?? (payload.hookEvent === 'UserPromptSubmit' ? 'prompt-submit' : 'pinned-manual');
  // A boundary row carries no prompt facts, whatever the payload holds.
  const prompt = isBoundaryEvent(eventType) ? null : payload.prompt;
  return {
    ts,
    tenantId: init.tenantId,
    runtime: init.runtime ?? (payload.hostTurnId !== null ? 'codex' : payload.hookEvent !== null ? 'claude-code' : 'unknown'),
    eventType,
    surface: 'hook',
    storeHash: init.storeHash,
    writeStore: init.writeStore,
    projectHash: facts !== null && facts.projectName !== '' ? blockHash(facts.projectName) : null,
    sessionId: payload.payloadSession ?? payload.envSession,
    sessionState: payload.sessionState,
    hostTurnId: payload.hostTurnId,
    promptHash: prompt !== null ? blockHash(prompt) : null,
    promptLength: prompt?.length ?? 0,
    queryHash: null,
    recallTraceId: null,
    blockState: state.disabledSeen ? 'disabled' : outcome.state,
    promptRecall: facts?.promptRecall === true,
    consideredCount: new Set([...state.candidates.keys(), ...state.picked.keys()]).size,
    filteredCount: state.filtered.size,
    selectedCount: state.picked.size,
    emittedCount: rows.filter((r) => r.outcome === 'emitted').length,
    rejectedCount: rejected.rejected + rejected.undecided,
    rejectedUnlisted: rejected.overflow + rejected.undecided,
    sectionsShown: state.shown,
    sectionsDropped: state.dropped,
    budgetTokens: facts?.budgetTokens ?? 0,
    selectedTokens: [...state.picked.values()].reduce((sum, p) => sum + p.tokens, 0),
    injectedTokens: emitted !== null ? estimateTokens(emitted) : 0,
    staticHash: outcome.staticHash ?? null,
    recallHash: outcome.recallHash ?? null,
    emittedHash: emitted !== null ? blockHash(emitted) : null,
    elapsedMs: Math.max(0, Date.now() - startedMs),
    candidates: rows,
  };
}

type CandidateMethods = Pick<DeliveryObserver, 'qualityDropped' | 'offer' | 'reject' | 'dropMissing' | 'gated' | 'selected'>;

/** The candidate-tracking half of the observer, each method run through `guard`. */
function candidateMethods(state: RecorderState, guard: Guard): CandidateMethods {
  return {
    qualityDropped: (e, isGlobal) => guard(() => {
      state.filtered.add(e.id);
      if (!state.candidates.has(e.id)) {
        state.candidates.set(e.id, {
          id: e.id, sourceStore: storeOf(isGlobal), pool: 'recent', stage: null, reason: null, score: null, tokens: null,
        });
      }
      rejectId(state, e.id, { stage: 'load', reason: 'quality', score: null, tokens: null });
    }),
    offer: (entries, isGlobal, pool) => guard(() => {
      for (const e of entries) {
        const held = state.candidates.get(e.id);
        const wanted: DeliveryPool = pool ?? (e.pinned ? 'pin' : 'recent');
        // A loaded recent row the prompt-recall gate then judges belongs to that pool.
        const relabel = held !== undefined && held.reason === null && held.pool === 'recent' && wanted === 'prompt-recall';
        if (held !== undefined && !relabel) continue;
        state.candidates.set(e.id, {
          id: e.id, sourceStore: storeOf(isGlobal), pool: wanted, stage: null, reason: null, score: null, tokens: null,
        });
      }
    }),
    reject: (e, stage, reason, score, tokens) => guard(() => rejectId(state, e.id, { stage, reason, score: score ?? null, tokens: tokens ?? null })),
    dropMissing: (before, after, stage, reason) => guard(() => {
      const kept = new Set(after.map((e) => e.id));
      for (const e of before) if (!kept.has(e.id)) rejectId(state, e.id, { stage, reason, score: null, tokens: null });
    }),
    gated: (prompt, items, gate, kept) => guard(() => {
      const keptIds = new Set(kept.map((g) => g.item.id));
      for (const c of items) {
        if (keptIds.has(c.id)) continue;
        const { score, shared } = scoreOverlap(prompt, c.tokens, gate.metric);
        const cleared = score >= gate.threshold && shared >= gate.minShared;
        rejectId(state, c.id, { stage: 'gate', reason: cleared ? 'gate-max-items' : 'gate-below-threshold', score, tokens: null });
      }
    }),
    selected: (items) => guard(() => {
      state.picked.clear();
      items.forEach((r, i) => {
        state.picked.set(r.entry.id, {
          entry: r.entry, rank: i + 1, score: r.score, tokens: r.tokens,
          sourceStore: storeOf(r.isGlobal), promptRecall: r.promptRecall === true,
        });
      });
    }),
  };
}

export type DeliveryFault = 'observe' | 'build' | 'flush';

let injectedFault: DeliveryFault | null = null;

/** Makes every recorder created afterwards throw at one stage. Only tests call it; the shipped CLI and server have no route here. */
export function _setDeliveryFaultForTests(fault: DeliveryFault | null): void {
  injectedFault = fault;
}

/** A recorder for one call; every observer method is guarded, and a throw marks it broken instead of escaping. */
export function createDeliveryRecorder(init: DeliveryRecorderInit): DeliveryRecorder {
  const startedMs = Date.now();
  const ts = evalNow().toISOString();
  const fault = injectedFault;
  const payload = readPayload(init);
  const state: RecorderState = {
    candidates: new Map(), picked: new Map(), filtered: new Set(), facts: null, shown: 0, dropped: 0,
    disabledSeen: false, outcome: { state: 'empty' }, broken: null, flushed: false,
  };

  const guard: Guard = (fn) => {
    if (state.broken !== null) return;
    try {
      if (fault === 'observe') throw new Error('injected observe fault');
      fn();
    } catch (error) {
      state.broken = errorMessage(error);
    }
  };
  const { qualityDropped, offer, reject, dropMissing, gated, selected } = candidateMethods(state, guard);

  return {
    root: init.root,
    facts: (f) => guard(() => { state.facts = { ...f }; }),
    sections: (s, d) => guard(() => { state.shown = s; state.dropped = d; }),
    watchAdmit: (admit) => (e) => {
      const ok = admit(e);
      if (!ok) guard(() => { state.filtered.add(e.id); });
      return ok;
    },
    qualityDropped,
    disabled: () => guard(() => { state.disabledSeen = true; }),
    offer,
    reject,
    dropMissing,
    gated,
    selected,
    delivered: (o) => guard(() => { state.outcome = { ...o }; }),
    flush: (write) => {
      if (state.flushed) return;
      state.flushed = true;
      if (state.broken !== null) {
        // Same pinned `[hippo] delivery ledger` hook stderr line as recall-trace.ts's write failure.
        console.error(`[hippo] delivery ledger skipped: recorder failed: ${state.broken}`);
        return;
      }
      if (fault === 'build') throw new Error('injected build fault');
      const input = buildEvent(init, payload, state, ts, startedMs);
      if (fault === 'flush') throw new Error('injected flush fault');
      write(input);
    },
  };
}
