import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { remember, retrieve } from '../../src/api/index.js';
import { ingestEvent, type IngestEvent } from '../../src/surface/connectors/github/ingest.js';
import type { IngestResult } from '../../src/surface/connectors/ingest.js';
import { handleCommentDeleted } from '../../src/surface/connectors/github/deletion.js';
import { computeIdempotencyKey } from '../../src/surface/connectors/github/signature.js';
import { resolveTenant, type RouteFallback } from '../../src/surface/connectors/tenant-route.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from '../../src/surface/connectors/github/types.js';
import { randomUUID } from 'node:crypto';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx, onSession } from '../_helpers/api-ctx.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { envTenant } from '../../src/base/util/env.js';
import { removeDir } from '../_helpers/remove-dir.js';

const fallback = (allowUnknown = false): RouteFallback => ({
  hostTenant: envTenant(),
  allowUnknown,
});

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
  readonly artifactRef?: string;
}

function repoFor(index: number): typeof PUBLIC_REPO | typeof PRIVATE_REPO {
  return index % 2 === 0 ? PUBLIC_REPO : PRIVATE_REPO;
}

function userFor(index: number) {
  const login = USERS[index % USERS.length];
  return { login, id: index + 1 };
}

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
      author_association: 'MEMBER',
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
      author_association: 'MEMBER',
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
      author_association: 'MEMBER',
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
      author_association: 'MEMBER',
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

function buildDeliveryStream(): GeneratedDelivery[] {
  const out: GeneratedDelivery[] = [];
  let i = 0;
  for (let n = 0; n < 50; n++) out.push(makeIssueDelivery(i++));
  for (let n = 0; n < 60; n++) out.push(makeIssueCommentDelivery(i++));
  for (let n = 0; n < 40; n++) out.push(makePullRequestDelivery(i++));
  for (let n = 0; n < 50; n++) out.push(makePrReviewCommentDelivery(i++));
  return out;
}

const ctxFor = (root: string, tenantId = 'default'): FullContext =>
  apiCtx(root, tenantId, { subject: 'connector:github', role: 'admin' });

function rawCount(root: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: the db driver's .get() returns `unknown`; `SELECT COUNT(*) AS c` always
    // yields exactly one row with a numeric (or bigint) `c` column.
    const row = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE kind = ?`).get('raw') as { c: number | bigint };
    return Number(row.c);
  } finally {
    closeHippoDb(db);
  }
}

describe('GitHub connector — 200-event smoke test', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('gh-smoke-200');
  });
  afterEach(() => {
    removeDir(root);
  });
  const { session } = sessionPerTest();

  it('ingests the stream cleanly and enforces every security boundary', async () => {
    const ctx = onSession(ctxFor(root), session());
    const deliveries = buildDeliveryStream();
    expect(deliveries).toHaveLength(200);

    const results: IngestResult[] = [];
    for (const d of deliveries) {
      results.push(
        await ingestEvent(ctx, {
          event: d.event,
          rawBody: d.rawBody,
          deliveryId: d.deliveryId,
        }),
      );
    }

    const ingested = results.filter((r) => r.status === 'ingested').length;
    expect(ingested).toBe(200);
    expect(rawCount(root)).toBe(200);

    const deletable = deliveries.filter((d): d is GeneratedDelivery & { artifactRef: string } =>
      Boolean(d.artifactRef),
    );
    expect(deletable).toHaveLength(110);
    const toDelete = deletable.slice(0, 5);
    const toDeleteIds = new Set(toDelete.map((d) => d.deliveryId));

    let archivedTotal = 0;
    for (const d of toDelete) {
      const idempotencyKey = computeIdempotencyKey(`${d.event.eventName}.deleted`, `delete:${d.artifactRef}`);
      const res = await handleCommentDeleted(ctx, {
        artifactRef: d.artifactRef,
        idempotencyKey,
        deliveryId: `del-${d.deliveryId}`,
        eventName: d.event.eventName,
      });
      expect(res.status).toBe('archived');
      archivedTotal += res.archivedCount;
    }
    expect(archivedTotal).toBe(5);

    const activeCount = rawCount(root);
    expect(activeCount).toBe(195);

    const allEntries = loadAllEntries(root, 'default');
    const ghEntries = allEntries.filter((e) => e.tags.includes('source:github'));
    expect(ghEntries).toHaveLength(195);

    for (const e of ghEntries) {
      expect(e.kind).toBe('raw');
      expect(e.tags).toContain('source:github');
      expect(e.owner).toMatch(/^user:github:/);
      expect(e.scope === SCOPE_PUBLIC || e.scope === SCOPE_PRIVATE).toBe(true);

      const repoTag = e.tags.find((t) => t.startsWith('repo:'));
      expect(repoTag).toMatch(/^repo:[^/]+\/[^/]+$/);
      const repoFull = repoTag!.slice('repo:'.length);
      if (e.scope === SCOPE_PUBLIC) {
        expect(repoFull).toBe(PUBLIC_REPO.full_name);
      } else {
        expect(repoFull).toBe(PRIVATE_REPO.full_name);
      }
    }

    const beforeReplay = rawCount(root);
    let duplicateCount = 0;
    for (const d of deliveries) {
      const r = await ingestEvent(ctx, {
        event: d.event,
        rawBody: d.rawBody,
        deliveryId: d.deliveryId,
      });
      expect(['duplicate', 'skipped', 'skipped_duplicate']).toContain(r.status);
      if (r.status === 'duplicate' || r.status === 'skipped_duplicate') {
        duplicateCount++;
      }
    }

    expect(rawCount(root)).toBe(beforeReplay);
    expect(duplicateCount).toBe(200);

    const privateDelivery = deliveries.find((d) => d.isPrivate && !toDeleteIds.has(d.deliveryId));
    expect(privateDelivery?.isPrivate).toBe(true);
    const privateMarker = privateDelivery!.markerText;

    const noScope = await retrieve(ctx, { query: privateMarker });
    const allPrivateMarkers = deliveries.filter((d) => d.isPrivate).map((d) => d.markerText);
    for (const r of noScope.results) {
      expect(r.content).not.toContain(privateMarker);
      for (const m of allPrivateMarkers) {
        expect(r.content).not.toContain(m);
      }
    }

    const withScope = await retrieve(ctx, {
      query: privateMarker,
      filter: { scope: SCOPE_PRIVATE },
    });
    expect(withScope.results).toHaveLength(1);
    expect(withScope.results.some((r) => r.content.includes(privateMarker))).toBe(true);

    const beforeReplayDef = rawCount(root);
    let replayDuplicates = 0;
    for (const d of deliveries) {
      const r = await ingestEvent(ctx, {
        event: d.event,
        rawBody: d.rawBody,
        deliveryId: randomUUID(),
      });
      expect(['duplicate', 'skipped', 'skipped_duplicate']).toContain(r.status);
      if (r.status === 'duplicate' || r.status === 'skipped_duplicate') {
        replayDuplicates++;
      }
    }
    expect(rawCount(root)).toBe(beforeReplayDef);
    expect(replayDuplicates).toBe(200);

    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        '99999',
        'tenant-known',
        new Date().toISOString(),
      );
      const resolved = await resolveTenant(
        sqliteStore(root),
        { connector: 'github', installationId: 'unknown-99' },
        fallback(),
      );
      expect(resolved).toBeNull();
    } finally {
      closeHippoDb(db);
    }

    await remember(ctx, {
      content: 'cross-scope-canary-payload-1234',
      kind: 'raw',
      scope: 'acme:private:demo',
      owner: 'user:acme:probe',
      artifactRef: 'acme://demo/secret/1',
      tags: ['source:acme'],
    });
    const canaryNoScope = await retrieve(ctx, {
      query: 'cross-scope-canary-payload-1234',
    });
    expect(canaryNoScope.results.some((r) => r.content.includes('cross-scope-canary-payload-1234'))).toBe(false);
    const canaryScoped = await retrieve(ctx, {
      query: 'cross-scope-canary-payload-1234',
      filter: { scope: 'acme:private:demo' },
    });
    expect(canaryScoped.results).toHaveLength(1);
    expect(canaryScoped.results[0].content).toBe('cross-scope-canary-payload-1234');
  });
});
