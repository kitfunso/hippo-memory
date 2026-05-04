/**
 * Task 16: 200-event GitHub connector smoke test.
 *
 * Streams 200 webhook deliveries (mix of all four event types, public + private
 * repos, varying users) plus 5 deletion events that archive a subset. Asserts
 * row counts, scope/owner/tag invariants, idempotent replay defense, scope-
 * filter denial on no-scope recall, the cross-source generic private filter,
 * and tenant routing fail-closed behaviour.
 *
 * Programmatic event generation — no static fixture file. Deterministic content
 * (`private-secret-marker-N` etc.) makes the no-scope denial check greppable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember, recall, type Context } from '../src/api.js';
import { ingestEvent, type IngestEvent, type IngestResult } from '../src/connectors/github/ingest.js';
import { handleCommentDeleted } from '../src/connectors/github/deletion.js';
import { computeIdempotencyKey } from '../src/connectors/github/signature.js';
import { resolveTenantForGitHub } from '../src/connectors/github/tenant-routing.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from '../src/connectors/github/types.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_REPO = {
  full_name: 'acme/public-repo',
  private: false,
  owner: { login: 'acme' },
  name: 'public-repo',
} as const;

const PRIVATE_REPO = {
  full_name: 'acme/secret-repo',
  private: true,
  owner: { login: 'acme' },
  name: 'secret-repo',
} as const;

const SCOPE_PUBLIC = `github:public:${PUBLIC_REPO.full_name}`;
const SCOPE_PRIVATE = `github:private:${PRIVATE_REPO.full_name}`;

const USERS = ['alice', 'bob', 'carol', 'dave', 'eve'] as const;

interface GeneratedDelivery {
  readonly event: IngestEvent;
  readonly rawBody: string;
  readonly deliveryId: string;
  readonly isPrivate: boolean;
  readonly markerText: string;
  /** Set on the 5 events we delete after the stream. */
  readonly artifactRef?: string;
}

function repoFor(index: number): typeof PUBLIC_REPO | typeof PRIVATE_REPO {
  // Roughly half public, half private. Index parity keeps it deterministic.
  return index % 2 === 0 ? PUBLIC_REPO : PRIVATE_REPO;
}

function userFor(index: number): { login: string; id: number } {
  const login = USERS[index % USERS.length];
  return { login, id: index + 1 };
}

/** Unique BM25 token per delivery — `markerXXXX` where XXXX is the index.
 *  Avoids cross-row token overlap so a recall on one marker returns exactly
 *  the rows whose body contains it. */
function uniqueMarker(index: number): string {
  return `zzmarker${String(index).padStart(4, '0')}zz`;
}

function makeIssueDelivery(index: number): GeneratedDelivery {
  const repo = repoFor(index);
  const user = userFor(index);
  const isPrivate = repo === PRIVATE_REPO;
  const markerText = uniqueMarker(index);
  const payload: GitHubIssueEvent = {
    action: 'opened',
    repository: { ...repo },
    issue: {
      number: 1000 + index,
      title: `issue-${index}`,
      body: `${markerText} body for issue ${index}`,
      user,
    },
    sender: user,
    installation: { id: 7777 },
  };
  return {
    event: { eventName: 'issues', payload },
    rawBody: JSON.stringify(payload),
    deliveryId: `issue-d-${index}`,
    isPrivate,
    markerText,
  };
}

function makeIssueCommentDelivery(index: number): GeneratedDelivery {
  const repo = repoFor(index);
  const user = userFor(index);
  const isPrivate = repo === PRIVATE_REPO;
  const markerText = uniqueMarker(index);
  const issueNumber = 2000 + index;
  const commentId = 50000 + index;
  const payload: GitHubIssueCommentEvent = {
    action: 'created',
    repository: { ...repo },
    issue: { number: issueNumber },
    comment: {
      id: commentId,
      body: `${markerText} comment ${index}`,
      user,
    },
    sender: user,
    installation: { id: 7777 },
  };
  return {
    event: { eventName: 'issue_comment', payload },
    rawBody: JSON.stringify(payload),
    deliveryId: `ic-d-${index}`,
    isPrivate,
    markerText,
    artifactRef: `github://${repo.full_name}/issue/${issueNumber}/comment/${commentId}`,
  };
}

function makePullRequestDelivery(index: number): GeneratedDelivery {
  const repo = repoFor(index);
  const user = userFor(index);
  const isPrivate = repo === PRIVATE_REPO;
  const markerText = uniqueMarker(index);
  const payload: GitHubPullRequestEvent = {
    action: 'opened',
    repository: { ...repo },
    pull_request: {
      number: 3000 + index,
      title: `pr-${index}`,
      body: `${markerText} pr body ${index}`,
      user,
    },
    sender: user,
    installation: { id: 7777 },
  };
  return {
    event: { eventName: 'pull_request', payload },
    rawBody: JSON.stringify(payload),
    deliveryId: `pr-d-${index}`,
    isPrivate,
    markerText,
  };
}

function makePrReviewCommentDelivery(index: number): GeneratedDelivery {
  const repo = repoFor(index);
  const user = userFor(index);
  const isPrivate = repo === PRIVATE_REPO;
  const markerText = uniqueMarker(index);
  const prNumber = 4000 + index;
  const commentId = 60000 + index;
  const payload: GitHubPullRequestReviewCommentEvent = {
    action: 'created',
    repository: { ...repo },
    pull_request: { number: prNumber },
    comment: {
      id: commentId,
      body: `${markerText} review comment ${index}`,
      user,
    },
    sender: user,
    installation: { id: 7777 },
  };
  return {
    event: { eventName: 'pull_request_review_comment', payload },
    rawBody: JSON.stringify(payload),
    deliveryId: `prc-d-${index}`,
    isPrivate,
    markerText,
    artifactRef: `github://${repo.full_name}/pull/${prNumber}/review_comment/${commentId}`,
  };
}

/**
 * Build the 200-delivery stream with the spec'd distribution:
 *   50 issues.opened
 *   60 issue_comment.created
 *   40 pull_request.opened
 *   50 pull_request_review_comment.created
 *
 * Indices are unique across the whole stream so artifact_refs never collide.
 */
function buildDeliveryStream(): GeneratedDelivery[] {
  const out: GeneratedDelivery[] = [];
  let i = 0;
  for (let n = 0; n < 50; n++) out.push(makeIssueDelivery(i++));
  for (let n = 0; n < 60; n++) out.push(makeIssueCommentDelivery(i++));
  for (let n = 0; n < 40; n++) out.push(makePullRequestDelivery(i++));
  for (let n = 0; n < 50; n++) out.push(makePrReviewCommentDelivery(i++));
  return out;
}

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-gh-smoke-200-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

const ctxFor = (root: string, tenantId = 'default'): Context => ({
  hippoRoot: root,
  tenantId,
  actor: 'connector:github',
});

function rawCount(root: string): number {
  const db = openHippoDb(root);
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM memories WHERE kind = ?`)
      .get('raw') as { c: number | bigint };
    return Number(row.c);
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHub connector — 200-event smoke test', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ingests the stream cleanly and enforces every security boundary', () => {
    const ctx = ctxFor(root);
    const deliveries = buildDeliveryStream();
    expect(deliveries).toHaveLength(200);

    // ---- Stream 1: ingest all 200 -----------------------------------------
    const results: IngestResult[] = [];
    for (const d of deliveries) {
      results.push(ingestEvent(ctx, { event: d.event, rawBody: d.rawBody, deliveryId: d.deliveryId }));
    }
    const ingested = results.filter((r) => r.status === 'ingested').length;
    expect(ingested).toBe(200);
    expect(rawCount(root)).toBe(200);

    // ---- Pick 5 deletable events (have artifactRefs) and archive them -----
    const deletable = deliveries.filter((d): d is GeneratedDelivery & { artifactRef: string } =>
      Boolean(d.artifactRef),
    );
    expect(deletable.length).toBeGreaterThanOrEqual(5);
    const toDelete = deletable.slice(0, 5);

    let archivedTotal = 0;
    for (const d of toDelete) {
      const idempotencyKey = computeIdempotencyKey(`${d.event.eventName}.deleted`, `delete:${d.artifactRef}`);
      const res = handleCommentDeleted(ctx, {
        artifactRef: d.artifactRef,
        idempotencyKey,
        deliveryId: `del-${d.deliveryId}`,
        eventName: d.event.eventName,
      });
      expect(res.status).toBe('archived');
      archivedTotal += res.archivedCount;
    }
    expect(archivedTotal).toBe(5);

    // (1) Exactly 195 active raw rows after the stream.
    const activeCount = rawCount(root);
    expect(activeCount).toBe(195);

    // ---- (2)(3)(4) Tag / scope / owner invariants on every active row ----
    const allEntries = loadAllEntries(root);
    const ghEntries = allEntries.filter((e) => e.tags.includes('source:github'));
    expect(ghEntries).toHaveLength(195);

    for (const e of ghEntries) {
      expect(e.kind).toBe('raw');
      expect(e.tags).toContain('source:github');
      expect(e.owner).toMatch(/^user:github:/);
      expect(e.scope === SCOPE_PUBLIC || e.scope === SCOPE_PRIVATE).toBe(true);

      // Cross-check scope ↔ tag agreement: the repo:<owner/name> tag must
      // identify the same repo as the scope's third segment.
      const repoTag = e.tags.find((t) => t.startsWith('repo:'));
      expect(repoTag).toBeDefined();
      const repoFull = repoTag!.slice('repo:'.length);
      if (e.scope === SCOPE_PUBLIC) {
        expect(repoFull).toBe(PUBLIC_REPO.full_name);
      } else {
        expect(repoFull).toBe(PRIVATE_REPO.full_name);
      }
    }

    // ---- (5) Re-running the same stream produces 0 new ingests -----------
    const beforeReplay = rawCount(root);
    let duplicateCount = 0;
    for (const d of deliveries) {
      const r = ingestEvent(ctx, { event: d.event, rawBody: d.rawBody, deliveryId: d.deliveryId });
      // Either fast-path 'duplicate' (live row) or 'skipped'/'duplicate' for
      // the 5 archived rows (their event_log row still exists -> 'duplicate').
      expect(['duplicate', 'skipped', 'skipped_duplicate']).toContain(r.status);
      if (r.status === 'duplicate' || r.status === 'skipped_duplicate') {
        duplicateCount++;
      }
    }
    expect(rawCount(root)).toBe(beforeReplay);
    expect(duplicateCount).toBe(200);

    // ---- (6) No-scope recall denial of a private repo memory -------------
    // Pick the first delivery whose repo was private, then recall its marker.
    const privateDelivery = deliveries.find(
      (d) => d.isPrivate && !toDelete.includes(d as GeneratedDelivery & { artifactRef: string }),
    );
    expect(privateDelivery).toBeDefined();
    const privateMarker = privateDelivery!.markerText;

    const noScope = recall(ctx, { query: privateMarker });
    // Default-deny: zero private rows surface to a no-scope caller.
    expect(noScope.results).toHaveLength(0);

    const withScope = recall(ctx, { query: privateMarker, scope: SCOPE_PRIVATE });
    expect(withScope.results.length).toBeGreaterThan(0);
    expect(withScope.results.some((r) => r.content.includes(privateMarker))).toBe(true);
    const noScopeDeniedCount = withScope.results.length - noScope.results.length;
    expect(noScopeDeniedCount).toBeGreaterThan(0);

    // ---- (7) Replay defense with a fresh deliveryId per delivery ---------
    const beforeReplayDef = rawCount(root);
    let replayDuplicates = 0;
    for (const d of deliveries) {
      const r = ingestEvent(ctx, {
        event: d.event,
        rawBody: d.rawBody,
        // Fresh UUID — body+eventName must still dedupe.
        deliveryId: randomUUID(),
      });
      expect(['duplicate', 'skipped', 'skipped_duplicate']).toContain(r.status);
      if (r.status === 'duplicate' || r.status === 'skipped_duplicate') {
        replayDuplicates++;
      }
    }
    expect(rawCount(root)).toBe(beforeReplayDef);
    expect(replayDuplicates).toBe(200);

    // ---- (8) Tenant routing failure for unknown installation -------------
    // Seed a routing table so we land in the multi-tenant branch.
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('99999', 'tenant-known', new Date().toISOString());
      const resolved = resolveTenantForGitHub(db, { installationId: 'unknown-99' });
      expect(resolved).toBeNull();
    } finally {
      closeHippoDb(db);
    }

    // ---- (9) Cross-scope leak negative test (generic private filter) -----
    // Insert a synthetic memory under acme:private:demo (NOT a github source).
    // The Task 0 generic-private filter should still hide it from no-scope recall.
    remember(ctx, {
      content: 'cross-scope-canary-payload-1234',
      kind: 'raw',
      scope: 'acme:private:demo',
      owner: 'user:acme:probe',
      artifactRef: 'acme://demo/secret/1',
      tags: ['source:acme'],
    });
    const canaryNoScope = recall(ctx, { query: 'cross-scope-canary-payload-1234' });
    expect(canaryNoScope.results).toHaveLength(0);
    const canaryScoped = recall(ctx, {
      query: 'cross-scope-canary-payload-1234',
      scope: 'acme:private:demo',
    });
    expect(canaryScoped.results.length).toBeGreaterThan(0);
  });
});
