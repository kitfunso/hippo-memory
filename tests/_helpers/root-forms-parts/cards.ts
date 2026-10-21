// Root-keyed cards forms tests call; production code goes through the store port or the At forms.

import type { Card, CardComment, CardRun } from '../../../src/base/records/card.js';
import type { HandoffOutcome } from '../../../src/base/session/handoff.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { assertTenantId } from '../../../src/base/scope/tenant-id.js';

export function createCard(
  hippoRoot: string,
  tenantId: string,
  input: { title: string; repo?: string; contract?: string; budget?: number; dependsOn?: string[] },
): Card {
  return sqliteSyncStore(hippoRoot).cards.create(tenantId, input);
}

export function loadCard(hippoRoot: string, tenantId: string, id: string): Card | null {
  return sqliteSyncStore(hippoRoot).cards.load(tenantId, id);
}

export function loadCardRuns(hippoRoot: string, tenantId: string, id: string): CardRun[] {
  assertTenantId('loadCardRuns', tenantId);
  return sqliteSyncStore(hippoRoot).cards.runs(tenantId, id);
}

export function claimCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  runtime: string,
  sessionId?: string,
): (Card & { runId: number }) | null {
  return sqliteSyncStore(hippoRoot).cards.claim(tenantId, id, runtime, sessionId);
}

export function heartbeatCard(hippoRoot: string, tenantId: string, id: string, runId: number): Card | null {
  return sqliteSyncStore(hippoRoot).cards.heartbeat(tenantId, id, runId);
}

export function blockCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  reason: string,
  runId?: number,
): Card | null {
  return sqliteSyncStore(hippoRoot).cards.block(tenantId, id, reason, runId);
}

export function reviewCard(hippoRoot: string, tenantId: string, id: string, runId?: number): Card | null {
  return sqliteSyncStore(hippoRoot).cards.review(tenantId, id, runId);
}

export function completeCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): { card: Card; promotedChildren: string[] } | null {
  return sqliteSyncStore(hippoRoot).cards.complete(tenantId, id, outcome, runId);
}

export function reclaimExpiredCards(hippoRoot: string, tenantId: string): string[] {
  return sqliteSyncStore(hippoRoot).cards.reclaimExpired(tenantId);
}

export function addCardComment(
  hippoRoot: string,
  tenantId: string,
  cardId: string,
  author: string,
  body: string,
): CardComment {
  return sqliteSyncStore(hippoRoot).cards.comment(tenantId, cardId, author, body);
}
