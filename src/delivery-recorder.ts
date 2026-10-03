// In-memory observer for one pinned-only context call: what was considered, why each was rejected, what reached stdout.
// No DB access (the caller hands build()'s output to src/recall-trace.ts); hashes, ids, counts and enums only, never text.
import type { MemoryEntry } from './memory.js';
import { evalNow } from './ablation.js';
import { scoreOverlap, type PromptRecallGate } from './prompt-recall.js';
import { blockHash, estimateTokens, hookPayloadSessionId, hookPayloadString, isSubagentPayload } from './token-ledger.js';

export type DeliveryRuntime = 'claude-code' | 'codex' | 'unknown';
export type DeliveryEventType = 'prompt-submit' | 'pinned-manual';
export type DeliverySurface = 'hook' | 'context';
export type DeliveryWriteStore = 'local' | 'global';
export type DeliverySessionState = 'payload' | 'env' | 'missing' | 'subagent';
export type DeliveryBlockState = 'sent' | 'reused' | 'reused-recall-sent' | 'empty' | 'disabled';
export type DeliveryPool = 'pin' | 'recent' | 'prompt-recall' | 'strength' | 'search';
export type DeliveryStage = 'load' | 'eligible' | 'gate' | 'budget' | 'limit' | 'final';
export type DeliveryOutcome = 'emitted' | 'reused' | 'rejected';
export type DeliveryRejectReason =
  | 'budget' | 'gate-below-threshold' | 'gate-max-items' | 'duplicate' | 'scope' | 'quality' | 'limit';

/** Row format version written to `delivery_events.ledger_version`. */
export const DELIVERY_LEDGER_VERSION = 1;
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
  /** The exact text written to stdout (the hook's additionalContext, or the printed block). */
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

/** A recorder for one call; every observer method is guarded, and a throw marks it broken instead of escaping. */
export function createDeliveryRecorder(init: DeliveryRecorderInit): DeliveryRecorder {
  const startedMs = Date.now();
  const ts = evalNow().toISOString();
  // Test-only fault injection, as HIPPO_FAKE_NOW is for time.
  const fault = process.env.HIPPO_TEST_DELIVERY_FAULT ?? '';

  const payloadSession = hookPayloadSessionId(init.stdinText);
  const subagent = isSubagentPayload(init.stdinText);
  const envSession = init.envSessionId !== undefined && init.envSessionId !== '' ? init.envSessionId : null;
  const prompt = hookPayloadString(init.stdinText, 'prompt');
  const hostTurnId = hookPayloadString(init.stdinText, 'turn_id');
  const hookEvent = hookPayloadString(init.stdinText, 'hook_event_name');
  const sessionState: DeliverySessionState = subagent
    ? 'subagent'
    : payloadSession !== null ? 'payload' : envSession !== null ? 'env' : 'missing';

  const candidates = new Map<string, Candidate>();
  const picked = new Map<string, Picked>();
  const filtered = new Set<string>();
  let facts: DeliveryFacts | null = null;
  let shown = 0;
  let dropped = 0;
  let disabledSeen = false;
  let outcome: DeliveryOutcomeInput = { state: 'empty' };
  let broken: string | null = null;
  let flushed = false;

  const guard = (fn: () => void): void => {
    if (broken !== null) return;
    try {
      if (fault === 'observe') throw new Error('injected observe fault');
      fn();
    } catch (error) {
      broken = error instanceof Error ? error.message : String(error);
    }
  };

  const rejectId = (id: string, stage: DeliveryStage, reason: DeliveryRejectReason, score: number | null, tokens: number | null): void => {
    const held = candidates.get(id);
    // First rejection wins; an id never offered is not a candidate of this call.
    if (!held || held.reason !== null) return;
    candidates.set(id, { ...held, stage, reason, score, tokens });
  };

  const build = (): DeliveryEventInput => {
    if (fault === 'build') throw new Error('injected build fault');
    const staticReused = outcome.staticReused === true;
    const rows: DeliveryCandidateInput[] = [];
    for (const p of picked.values()) {
      const held = candidates.get(p.entry.id);
      rows.push({
        memoryId: p.entry.id,
        sourceStore: held?.sourceStore ?? p.sourceStore,
        pool: p.promptRecall ? 'prompt-recall' : held?.pool === 'pin' || p.entry.pinned ? 'pin' : 'recent',
        stage: 'final',
        outcome: staticReused && !p.promptRecall ? 'reused' : 'emitted',
        reason: null,
        rank: p.rank,
        score: p.score,
        tokens: p.tokens,
      });
    }
    const rejected: Candidate[] = [];
    let undecided = 0;
    for (const c of candidates.values()) {
      if (picked.has(c.id)) continue;
      if (c.reason === null) undecided += 1;
      else rejected.push(c);
    }
    rejected.sort(byDepthThenScore);
    for (const c of rejected.slice(0, DELIVERY_REJECTED_ROW_CAP)) {
      rows.push({
        memoryId: c.id, sourceStore: c.sourceStore, pool: c.pool, stage: c.stage ?? 'load', outcome: 'rejected',
        reason: c.reason, rank: null, score: c.score, tokens: c.tokens,
      });
    }
    const overflow = Math.max(0, rejected.length - DELIVERY_REJECTED_ROW_CAP);
    const emitted = outcome.emittedText ?? null;
    return {
      ts,
      tenantId: init.tenantId,
      runtime: hostTurnId !== null ? 'codex' : hookEvent !== null ? 'claude-code' : 'unknown',
      eventType: hookEvent === 'UserPromptSubmit' ? 'prompt-submit' : 'pinned-manual',
      surface: 'hook',
      storeHash: init.storeHash,
      writeStore: init.writeStore,
      projectHash: facts !== null && facts.projectName !== '' ? blockHash(facts.projectName) : null,
      sessionId: payloadSession ?? envSession,
      sessionState,
      hostTurnId,
      promptHash: prompt !== null ? blockHash(prompt) : null,
      promptLength: prompt?.length ?? 0,
      queryHash: null,
      recallTraceId: null,
      blockState: disabledSeen ? 'disabled' : outcome.state,
      promptRecall: facts?.promptRecall === true,
      consideredCount: new Set([...candidates.keys(), ...picked.keys()]).size,
      filteredCount: filtered.size,
      selectedCount: picked.size,
      emittedCount: rows.filter((r) => r.outcome === 'emitted').length,
      rejectedCount: rejected.length + undecided,
      rejectedUnlisted: overflow + undecided,
      sectionsShown: shown,
      sectionsDropped: dropped,
      budgetTokens: facts?.budgetTokens ?? 0,
      selectedTokens: [...picked.values()].reduce((sum, p) => sum + p.tokens, 0),
      injectedTokens: emitted !== null ? estimateTokens(emitted) : 0,
      staticHash: outcome.staticHash ?? null,
      recallHash: outcome.recallHash ?? null,
      emittedHash: emitted !== null ? blockHash(emitted) : null,
      elapsedMs: Math.max(0, Date.now() - startedMs),
      candidates: rows,
    };
  };

  return {
    root: init.root,
    facts: (f) => guard(() => { facts = { ...f }; }),
    sections: (s, d) => guard(() => { shown = s; dropped = d; }),
    watchAdmit: (admit) => (e) => {
      const ok = admit(e);
      if (!ok) guard(() => { filtered.add(e.id); });
      return ok;
    },
    disabled: () => guard(() => { disabledSeen = true; }),
    offer: (entries, isGlobal, pool) => guard(() => {
      for (const e of entries) {
        const held = candidates.get(e.id);
        const wanted: DeliveryPool = pool ?? (e.pinned ? 'pin' : 'recent');
        // A loaded recent row the prompt-recall gate then judges belongs to that pool.
        const relabel = held !== undefined && held.reason === null && held.pool === 'recent' && wanted === 'prompt-recall';
        if (held !== undefined && !relabel) continue;
        candidates.set(e.id, {
          id: e.id, sourceStore: storeOf(isGlobal), pool: wanted, stage: null, reason: null, score: null, tokens: null,
        });
      }
    }),
    reject: (e, stage, reason, score, tokens) => guard(() => rejectId(e.id, stage, reason, score ?? null, tokens ?? null)),
    dropMissing: (before, after, stage, reason) => guard(() => {
      const kept = new Set(after.map((e) => e.id));
      for (const e of before) if (!kept.has(e.id)) rejectId(e.id, stage, reason, null, null);
    }),
    gated: (prompt, items, gate, kept) => guard(() => {
      const keptIds = new Set(kept.map((g) => g.item.id));
      for (const c of items) {
        if (keptIds.has(c.id)) continue;
        const { score, shared } = scoreOverlap(prompt, c.tokens, gate.metric);
        const cleared = score >= gate.threshold && shared >= gate.minShared;
        rejectId(c.id, 'gate', cleared ? 'gate-max-items' : 'gate-below-threshold', score, null);
      }
    }),
    selected: (items) => guard(() => {
      picked.clear();
      items.forEach((r, i) => {
        picked.set(r.entry.id, {
          entry: r.entry, rank: i + 1, score: r.score, tokens: r.tokens,
          sourceStore: storeOf(r.isGlobal), promptRecall: r.promptRecall === true,
        });
      });
    }),
    delivered: (o) => guard(() => { outcome = { ...o }; }),
    flush: (write) => {
      if (flushed) return;
      flushed = true;
      if (broken !== null) {
        console.error(`[hippo] delivery ledger skipped: recorder failed: ${broken}`);
        return;
      }
      const input = build();
      if (fault === 'flush') throw new Error('injected flush fault');
      write(input);
    },
  };
}
