// Event and row builders, a ledger writer and the readers the delivery exit-reader tests share.
import { expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { writeDeliveryEventOnHandle } from '../../src/store/sqlite/recall-trace.js';
import type {
  DeliveryCandidateInput,
  DeliveryEventInput,
  DeliveryRejectReason,
  DeliveryStage,
} from '../../src/core/delivery.js';
import { blockHash } from '../../src/util/token-text.js';
import { realpathOrResolve } from '../../src/util/real-path.js';
import type { JsonValue } from '../../src/util/json.js';
import { seed, verdictOf, writeHostTranscript, type ReadOptions } from '../_helpers/host-transcript.js';
import { type Project } from '../_helpers/delivery-boundary.js';
import { makeRoot } from '../_helpers/make-root.js';

export const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'z10-reconstruct.mjs');
export const STAGES: DeliveryStage[] = ['load', 'eligible', 'gate', 'budget', 'limit', 'final'];
export const REASONS: DeliveryRejectReason[] = [
  'budget',
  'gate-below-threshold',
  'gate-max-items',
  'duplicate',
  'scope',
  'quality',
  'limit',
];
export const CREATED = '2026-09-01T00:00:00.000Z';
const STATIC = 'aaaaaaaaaaaaaaaa';

export interface Json {
  [key: string]: JsonValue;
}

export let dir: string;
let tick = 0;

export function useExitReaderStore() {
  beforeEach(() => {
    dir = makeRoot('z10-reader');
    tick = 0;
  });
}

/** Event inputs are 10 s apart so the writer's duplicate window never joins two of them. */
export function event(session: string, o: Partial<DeliveryEventInput> = {}): DeliveryEventInput {
  tick += 1;
  return {
    ts: new Date(Date.parse('2026-10-01T00:00:00.000Z') + tick * 10_000).toISOString(),
    tenantId: 'default',
    runtime: 'claude-code',
    eventType: 'prompt-submit',
    surface: 'hook',
    storeHash: blockHash(realpathOrResolve(dir)),
    writeStore: 'local',
    projectHash: null,
    sessionId: session,
    sessionState: 'payload',
    hostTurnId: null,
    promptHash: blockHash(`prompt ${tick}`),
    promptLength: 5,
    queryHash: null,
    recallTraceId: null,
    blockState: 'sent',
    promptRecall: false,
    consideredCount: 1,
    filteredCount: 0,
    selectedCount: 1,
    emittedCount: 1,
    rejectedCount: 0,
    rejectedUnlisted: 0,
    sectionsShown: 0,
    sectionsDropped: 0,
    budgetTokens: 1000,
    selectedTokens: 10,
    injectedTokens: 10,
    staticHash: STATIC,
    recallHash: null,
    emittedHash: null,
    elapsedMs: 1,
    candidates: [],
    ...o,
  };
}

export const row = (memoryId: string, o: Partial<DeliveryCandidateInput> = {}): DeliveryCandidateInput => ({
  memoryId,
  sourceStore: 'local',
  pool: 'pin',
  stage: 'final',
  outcome: 'emitted',
  reason: null,
  rank: 1,
  score: 1,
  tokens: 10,
  ...o,
});

export function write(input: DeliveryEventInput): number {
  const db = openHippoDb(dir);
  try {
    const id = writeDeliveryEventOnHandle(db, input);
    expect(id).not.toBeNull();
    return Number(id);
  } finally {
    closeHippoDb(db);
  }
}

export const read = (session: string, memory: string, extra: ReadOptions = {}) =>
  verdictOf({ store: dir, session, memory, ...extra });
export const present = (content = 'a lesson that was written before every turn here') =>
  seed(dir, content, { created: CREATED });
export const transcript = (specs: Parameters<typeof writeHostTranscript>[1]): string =>
  // SAFETY: writeHostTranscript reads only the project's dir.
  writeHostTranscript({ dir } as Project, specs, { noise: false });
