// The event row the delivery recorder writes: the payload facts, the picked and rejected rows
// and the counts.
import {
  hookPayloadSessionId,
  hookPayloadString,
  isSubagentPayload,
} from '../base/util/hook-payload.js';
import { blockHash, estimateTokens } from '../base/util/token-text.js';
import { MAX_HOOK_FIELD_LEN } from '../base/util/limits.js';
import type {
  DeliveryCandidateInput,
  DeliveryEventInput,
  DeliveryEventType,
  DeliveryPool,
  DeliveryRuntime,
  DeliverySessionState,
  DeliveryStage,
} from '../base/session/delivery.js';
import type { DeliveryRecorderInit } from './delivery-recorder.js';
import type { Candidate, Picked, RecorderState } from './delivery-observation.js';

/** Only the per-prompt calls keep prompt facts; a boundary or a `hippo context` run is not a
 * prompt. */
const carriesPrompt = (type: DeliveryEventType): boolean =>
  type === 'prompt-submit' || type === 'pinned-manual';

/** Rejected candidate rows kept per event; the rest only add to `rejected_unlisted`. */
const DELIVERY_REJECTED_ROW_CAP = 16;

// Deeper stages were closer to being sent, so the row cap keeps them first.
const STAGE_DEPTH: ReadonlyMap<DeliveryStage, number> = new Map<DeliveryStage, number>([
  ['load', 0],
  ['eligible', 1],
  ['gate', 2],
  ['budget', 3],
  ['limit', 4],
  ['final', 5],
]);

function byDepthThenScore(a: Candidate, b: Candidate): number {
  const depth =
    (STAGE_DEPTH.get(b.stage ?? 'load') ?? 0) - (STAGE_DEPTH.get(a.stage ?? 'load') ?? 0);
  if (depth !== 0) return depth;
  const score = (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY);
  if (score !== 0 && !Number.isNaN(score)) return score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What the hook payload and env say about the call, read once at creation. */
export interface PayloadFacts {
  payloadSession: string | null;
  envSession: string | null;
  prompt: string | null;
  hostTurnId: string | null;
  hookEvent: string | null;
  toolUseId: string | null;
  sessionState: DeliverySessionState;
}

export function readPayload(init: DeliveryRecorderInit): PayloadFacts {
  const payloadSession = hookPayloadSessionId(init.stdinText);
  const subagent = isSubagentPayload(init.stdinText);
  const envSession =
    init.envSessionId !== undefined && init.envSessionId !== '' ? init.envSessionId : null;
  const prompt = hookPayloadString(init.stdinText, 'prompt');
  const rawTurnId = hookPayloadString(init.stdinText, 'turn_id');
  const hostTurnId = rawTurnId !== null && rawTurnId.trim() !== '' ? rawTurnId : null;
  const hookEvent = hookPayloadString(init.stdinText, 'hook_event_name');
  const rawToolUseId = hookPayloadString(init.stdinText, 'tool_use_id')?.trim() ?? '';
  // Cut as failure_log cuts its payload fields: the payload is not trusted to be short.
  const toolUseId = rawToolUseId !== '' ? rawToolUseId.slice(0, MAX_HOOK_FIELD_LEN) : null;
  const sessionState: DeliverySessionState = subagent
    ? 'subagent'
    : payloadSession !== null
      ? 'payload'
      : envSession !== null
        ? 'env'
        : 'missing';
  return { payloadSession, envSession, prompt, hostTurnId, hookEvent, toolUseId, sessionState };
}

function pickedPool(p: Picked, held: Candidate | undefined): DeliveryPool {
  if (p.promptRecall) return 'prompt-recall';
  // A ranked call's rows keep the ranking that chose them, a pinned hit included.
  if (held?.pool === 'search' || held?.pool === 'strength') return held.pool;
  return held?.pool === 'pin' || p.entry.pinned ? 'pin' : 'recent';
}

function pickedRows(state: RecorderState): DeliveryCandidateInput[] {
  const staticReused = state.outcome.staticReused === true;
  const rows: DeliveryCandidateInput[] = [];
  for (const p of state.picked.values()) {
    rows.push({
      memoryId: p.entry.id,
      sourceStore: p.sourceStore,
      pool: pickedPool(p, state.candidates.get(p.entry.id)),
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
    memoryId: c.id,
    sourceStore: c.sourceStore,
    pool: c.pool,
    stage: c.stage ?? 'load',
    outcome: 'rejected',
    reason: c.reason,
    rank: null,
    score: c.score,
    tokens: c.tokens,
  }));
  const overflow = Math.max(0, rejected.length - DELIVERY_REJECTED_ROW_CAP);
  return { rows, rejected: rejected.length, undecided, overflow };
}

type DeliveryCounts = Pick<
  DeliveryEventInput,
  | 'consideredCount'
  | 'filteredCount'
  | 'selectedCount'
  | 'emittedCount'
  | 'rejectedCount'
  | 'rejectedUnlisted'
>;

function deliveryCounts(
  state: RecorderState,
  rows: DeliveryEventInput['candidates'],
  rejected: ReturnType<typeof rejectedRows>,
): DeliveryCounts {
  return {
    consideredCount: new Set([...state.candidates.keys(), ...state.picked.keys()]).size,
    filteredCount: state.filtered.size,
    selectedCount: state.picked.size,
    emittedCount: rows.filter((r) => r.outcome === 'emitted').length,
    rejectedCount: rejected.rejected + rejected.undecided,
    rejectedUnlisted: rejected.overflow + rejected.undecided,
  };
}

function inferRuntime(payload: PayloadFacts): DeliveryRuntime {
  return payload.hostTurnId !== null
    ? 'codex'
    : payload.hookEvent !== null
      ? 'claude-code'
      : 'unknown';
}

function promptFields(
  payload: PayloadFacts,
  eventType: DeliveryEventType,
): Pick<DeliveryEventInput, 'promptHash' | 'promptLength'> {
  // Whatever the payload holds, so a hook-run `hippo context` is never matched to an earlier row by
  // its prompt.
  const prompt = carriesPrompt(eventType) ? payload.prompt : null;
  return {
    promptHash: prompt !== null ? blockHash(prompt) : null,
    promptLength: prompt?.length ?? 0,
  };
}

type SentFields = Pick<
  DeliveryEventInput,
  | 'sectionsShown'
  | 'sectionsDropped'
  | 'budgetTokens'
  | 'selectedTokens'
  | 'injectedTokens'
  | 'staticHash'
  | 'recallHash'
  | 'emittedHash'
  | 'elapsedMs'
>;

function sentFields(state: RecorderState, startedMs: number): SentFields {
  const { facts, outcome } = state;
  const emitted = outcome.emittedText ?? null;
  return {
    sectionsShown: state.shown,
    sectionsDropped: state.dropped,
    budgetTokens: facts?.budgetTokens ?? 0,
    selectedTokens: [...state.picked.values()].reduce((sum, p) => sum + p.tokens, 0),
    injectedTokens: emitted !== null ? estimateTokens(emitted) : 0,
    staticHash: outcome.staticHash ?? null,
    recallHash: outcome.recallHash ?? null,
    emittedHash: emitted !== null ? blockHash(emitted) : null,
    elapsedMs: Math.max(0, Date.now() - startedMs),
  };
}

interface BuildEventOptions {
  readonly init: DeliveryRecorderInit;
  readonly payload: PayloadFacts;
  readonly state: RecorderState;
  readonly ts: string;
  readonly startedMs: number;
}

export function buildEvent({
  init,
  payload,
  state,
  ts,
  startedMs,
}: BuildEventOptions): DeliveryEventInput {
  const { facts, outcome } = state;
  const picked = pickedRows(state);
  const rejected = rejectedRows(state);
  const rows = [...picked, ...rejected.rows];
  const eventType =
    init.eventType ??
    (payload.hookEvent === 'UserPromptSubmit' ? 'prompt-submit' : 'pinned-manual');
  return {
    ts,
    tenantId: init.tenantId,
    runtime: init.runtime ?? inferRuntime(payload),
    eventType,
    surface: eventType === 'context' ? 'context' : 'hook',
    storeHash: init.storeHash,
    writeStore: init.writeStore,
    projectHash: facts !== null && facts.projectName !== '' ? blockHash(facts.projectName) : null,
    sessionId: payload.payloadSession ?? payload.envSession,
    sessionState: payload.sessionState,
    hostTurnId: payload.hostTurnId,
    ...promptFields(payload, eventType),
    queryHash: state.queryHash,
    recallTraceId: state.recallTraceId,
    blockState: state.disabledSeen ? 'disabled' : outcome.state,
    promptRecall: facts?.promptRecall === true,
    ...deliveryCounts(state, rows, rejected),
    ...sentFields(state, startedMs),
    toolUseId: eventType === 'tool-failure' ? payload.toolUseId : null,
    failureId: eventType === 'tool-failure' ? state.failureId : null,
    candidates: rows,
  };
}
