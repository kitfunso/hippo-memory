// Root-keyed cards forms tests call; production code goes through the port or the handle-first forms.

import type { Card, CardComment, CardRun } from '../../../src/base/records/card.js';
import type { HandoffOutcome } from '../../../src/base/session/handoff.js';
import { sqliteStore } from '../../../src/store/sqlite/store.js';
import { assertTenantId } from '../../../src/base/scope/tenant-id.js';

export async function createCard(
  hippoRoot: string,
  tenantId: string,
  input: {
    title: string;
    repo?: string;
    contract?: string;
    budget?: number;
    dependsOn?: string[];
  },
): Promise<Card> {
  return await sqliteStore(hippoRoot).cards.create(tenantId, input);
}

export async function loadCard(hippoRoot: string, tenantId: string, id: string): Promise<Card | null> {
  return await sqliteStore(hippoRoot).cards.load(tenantId, id);
}

export async function loadCardRuns(hippoRoot: string, tenantId: string, id: string): Promise<CardRun[]> {
  assertTenantId('loadCardRuns', tenantId);
  return await sqliteStore(hippoRoot).cards.runs(tenantId, id);
}

export async function claimCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  runtime: string,
  sessionId?: string,
): Promise<(Card & { runId: number }) | null> {
  return await sqliteStore(hippoRoot).cards.claim(tenantId, id, runtime, sessionId);
}

export async function heartbeatCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  runId: number,
): Promise<Card | null> {
  return await sqliteStore(hippoRoot).cards.heartbeat(tenantId, id, runId);
}

export async function blockCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  reason: string,
  runId?: number,
): Promise<Card | null> {
  return await sqliteStore(hippoRoot).cards.block(tenantId, id, reason, runId);
}

export async function reviewCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  runId?: number,
): Promise<Card | null> {
  return await sqliteStore(hippoRoot).cards.review(tenantId, id, runId);
}

export async function completeCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): Promise<{ card: Card; promotedChildren: string[] } | null> {
  return await sqliteStore(hippoRoot).cards.complete(tenantId, id, outcome, runId);
}

export async function reclaimExpiredCards(hippoRoot: string, tenantId: string): Promise<string[]> {
  return await sqliteStore(hippoRoot).cards.reclaimExpired(tenantId);
}

export async function addCardComment(
  hippoRoot: string,
  tenantId: string,
  cardId: string,
  author: string,
  body: string,
): Promise<CardComment> {
  return await sqliteStore(hippoRoot).cards.comment(tenantId, cardId, author, body);
}
