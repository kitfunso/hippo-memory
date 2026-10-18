import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { remember } from '../../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { ingestEvent, type IngestEvent, type IngestInput } from '../../src/connectors/github/ingest.js';
import type { IngestResult } from '../../src/connectors/ingest.js';
import { computeIdempotencyKey } from '../../src/connectors/github/signature.js';
import { issueEventToRememberOpts } from '../../src/connectors/github/transform.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from '../../src/connectors/github/types.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { stageScratchWinner } from '../_helpers/race-winner.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

// -- Test helpers ----------------------------------------------------------

const ctx = (root: string): FullContext => apiCtx(root, 'default', { subject: 'connector:github', role: 'admin' });

function makeIssueEvent(overrides: Partial<GitHubIssueEvent['issue']> = {}): GitHubIssueEvent {
  return {
    action: 'opened',
    repository: {
      full_name: 'acme/demo',
      private: false,
      owner: { login: 'acme' },
      name: 'demo',
    },
    issue: {
      number: 42,
      title: 'Bug: thing broke',
      body: 'Steps to reproduce: 1, 2, 3.',
      user: { login: 'alice', id: 1 },
      ...overrides,
    },
  };
}

function makeIssueCommentEvent(): GitHubIssueCommentEvent {
  return {
    action: 'created',
    repository: {
      full_name: 'acme/demo',
      private: false,
      owner: { login: 'acme' },
      name: 'demo',
    },
    issue: { number: 42 },
    comment: {
      id: 999,
      body: 'I can repro on macOS.',
      user: { login: 'bob', id: 2 },
    },
  };
}

function makePullRequestEvent(): GitHubPullRequestEvent {
  return {
    action: 'opened',
    repository: {
      full_name: 'acme/demo',
      private: false,
      owner: { login: 'acme' },
      name: 'demo',
    },
    pull_request: {
      number: 7,
      title: 'Fix bug 42',
      body: 'Patches the off-by-one.',
      user: { login: 'carol', id: 3 },
    },
  };
}

function makePrReviewCommentEvent(): GitHubPullRequestReviewCommentEvent {
  return {
    action: 'created',
    repository: {
      full_name: 'acme/demo',
      private: false,
      owner: { login: 'acme' },
      name: 'demo',
    },
    pull_request: { number: 7 },
    comment: {
      id: 12345,
      body: 'Nit: rename this var.',
      user: { login: 'dave', id: 4 },
    },
  };
}

interface LostRace {
  readonly loser: IngestResult;
  readonly winner: IngestResult;
}

/** The second worker's write of the same issue event, run on a scratch store so its rows can be copied in under a held lock. */
async function storeAsOtherWorker(scratch: string, { event }: IngestInput): Promise<IngestResult> {
  const opts = event.eventName === 'issues' ? issueEventToRememberOpts(event.payload) : null;
  if (event.eventName !== 'issues' || !opts) throw new Error('the raced event is an issue with a body');
  const { issue, repository } = event.payload;
  const idempotencyKey = computeIdempotencyKey(
    `github://${repository?.full_name}/issue/${issue.number}`,
    issue.updated_at ?? null,
  );
  const logged = { connector: 'github', idempotencyKey, deliveryId: 'd-other-worker', eventName: 'issues' } as const;
  const stored = await remember(ctx(scratch), { ...opts, untrusted: true, event: logged });
  return {
    status: stored.duplicate ? 'skipped_duplicate' : 'ingested',
    memoryId: stored.duplicate?.memoryId ?? stored.id,
  };
}

/** Ingests `input` as the loser of a race: another process holds the write lock with the second worker's rows, and commits them while this ingest waits. */
async function ingestBehindAnotherWorker(root: string, input: IngestInput): Promise<LostRace> {
  const scratch = makeRoot('gh-winner');
  const winner = await storeAsOtherWorker(scratch, input);
  const staged = await stageScratchWinner(root, scratch, ['memories', 'github_event_log']);
  const loser = await ingestEvent(ctx(root), input);
  await staged.committed;
  return { loser, winner };
}

// -- Tests -----------------------------------------------------------------

describe('ingestEvent', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('gh-ingest');
  });

  it('1. fresh ingest: writes a kind=raw memory and stamps github_event_log', async () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const result = await ingestEvent(ctx(root), {
      event,
      rawBody,
      deliveryId: 'd-1',
    });

    expect(result.status).toBe('ingested');
    expect(result.memoryId).toBeTruthy();

    // Memory exists with correct shape.
    const entries = loadAllEntries(root, 'default');
    const ghEntries = entries.filter((e) => e.tags.includes('source:github'));
    expect(ghEntries).toHaveLength(1);
    const entry = ghEntries[0];
    expect(entry.kind).toBe('raw');
    expect(entry.scope).toBe('github:public:acme/demo');
    expect(entry.owner).toBe('user:github:alice');
    expect(entry.artifact_ref).toBe('github://acme/demo/issue/42');

    // github_event_log row written.
    const db = openHippoDb(root);
    try {
      const idempotencyKey = computeIdempotencyKey('github://acme/demo/issue/42', null);
      // SAFETY: the SELECT explicitly lists idempotency_key, delivery_id,
      // event_name, memory_id, so the row shape matches.
      const row = db
        .prepare(
          `SELECT idempotency_key, delivery_id, event_name, memory_id FROM github_event_log WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as
        | { idempotency_key: string; delivery_id: string; event_name: string; memory_id: string | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.delivery_id).toBe('d-1');
      expect(row?.event_name).toBe('issues');
      expect(row?.memory_id).toBe(result.memoryId);
    } finally {
      closeHippoDb(db);
    }
  });

  it('2. duplicate fast path: same (eventName, rawBody) returns duplicate with same memoryId', async () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const r1 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-1' });
    expect(r1.status).toBe('ingested');

    const r2 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);

    // Still only one memory row.
    const entries = loadAllEntries(root, 'default');
    expect(entries.filter((e) => e.tags.includes('source:github'))).toHaveLength(1);
  });

  it('3. empty body skip: returns skipped, log row has memory_id=NULL, replay returns duplicate', async () => {
    const payload: GitHubIssueEvent = {
      action: 'opened',
      repository: {
        full_name: 'acme/demo',
        private: false,
        owner: { login: 'acme' },
        name: 'demo',
      },
      issue: {
        number: 42,
        title: '',
        body: null,
        user: { login: 'alice', id: 1 },
      },
    };
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const r1 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-1' });
    expect(r1.status).toBe('skipped');
    expect(r1.memoryId).toBeNull();

    // No memory row.
    const entries = loadAllEntries(root, 'default');
    expect(entries.filter((e) => e.tags.includes('source:github'))).toHaveLength(0);

    // github_event_log row exists with memory_id=NULL.
    const db = openHippoDb(root);
    try {
      const key = computeIdempotencyKey('github://acme/demo/issue/42', null);
      // SAFETY: the SELECT explicitly lists memory_id, so the row shape matches.
      const row = db.prepare(`SELECT memory_id FROM github_event_log WHERE idempotency_key = ?`).get(key) as
        | { memory_id: string | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.memory_id).toBeNull();
    } finally {
      closeHippoDb(db);
    }

    // Replay returns 'duplicate', not 'skipped' (transform isn't re-run).
    const r2 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBeNull();
  });

  it('4. all four event types ingest with correct artifact_ref shapes', async () => {
    const issuePayload = makeIssueEvent();
    const issueCommentPayload = makeIssueCommentEvent();
    const prPayload = makePullRequestEvent();
    const prReviewCommentPayload = makePrReviewCommentEvent();

    const r1 = await ingestEvent(ctx(root), {
      event: { eventName: 'issues', payload: issuePayload },
      rawBody: JSON.stringify(issuePayload),
      deliveryId: 'd-1',
    });
    const r2 = await ingestEvent(ctx(root), {
      event: { eventName: 'issue_comment', payload: issueCommentPayload },
      rawBody: JSON.stringify(issueCommentPayload),
      deliveryId: 'd-2',
    });
    const r3 = await ingestEvent(ctx(root), {
      event: { eventName: 'pull_request', payload: prPayload },
      rawBody: JSON.stringify(prPayload),
      deliveryId: 'd-3',
    });
    const r4 = await ingestEvent(ctx(root), {
      event: { eventName: 'pull_request_review_comment', payload: prReviewCommentPayload },
      rawBody: JSON.stringify(prReviewCommentPayload),
      deliveryId: 'd-4',
    });

    expect(r1.status).toBe('ingested');
    expect(r2.status).toBe('ingested');
    expect(r3.status).toBe('ingested');
    expect(r4.status).toBe('ingested');

    const entries = loadAllEntries(root, 'default');
    const refs = new Set(entries.map((e) => e.artifact_ref).filter((r): r is string => !!r));
    expect(refs.has('github://acme/demo/issue/42')).toBe(true);
    expect(refs.has('github://acme/demo/issue/42/comment/999')).toBe(true);
    expect(refs.has('github://acme/demo/pull/7')).toBe(true);
    expect(refs.has('github://acme/demo/pull/7/review_comment/12345')).toBe(true);
  });

  it('5. race with a second worker: the lost write rolls back, returns skipped_duplicate with other worker memoryId', async () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const { loser: result, winner } = await ingestBehindAnotherWorker(root, {
      event,
      rawBody,
      deliveryId: 'd-this-worker',
    });
    const otherWorkerMemoryId = winner.memoryId;

    expect(winner.status).toBe('ingested');
    expect(result.status).toBe('skipped_duplicate');
    expect(result.memoryId).toBe(otherWorkerMemoryId);

    // The github_event_log delivery_id is the OTHER worker's, confirming
    // ingest's INSERT OR IGNORE was the loser of the race.
    const db = openHippoDb(root);
    try {
      const key = computeIdempotencyKey('github://acme/demo/issue/42', null);
      // SAFETY: the SELECT explicitly lists delivery_id, memory_id, so the row shape matches.
      const row = db
        .prepare(`SELECT delivery_id, memory_id FROM github_event_log WHERE idempotency_key = ?`)
        .get(key) as { delivery_id: string; memory_id: string | null } | undefined;
      expect(row?.delivery_id).toBe('d-other-worker');
      expect(row?.memory_id).toBe(otherWorkerMemoryId);
    } finally {
      closeHippoDb(db);
    }
  });

  it('6. replay defense: same body with two different deliveryIds returns duplicate on second call', async () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const r1 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'attacker-replay-uuid-1' });
    expect(r1.status).toBe('ingested');

    // Same signed body, different (unsigned, attacker-controlled) delivery UUID.
    const r2 = await ingestEvent(ctx(root), { event, rawBody, deliveryId: 'attacker-replay-uuid-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);
  });

  it('7. different artifact_refs produce different idempotency keys; same artifact + same updated_at collapses', () => {
    // The v1.3.1 hotfix changed the key from sha256(eventName + ':' + rawBody)
    // to sha256(artifactRef + ':' + updatedAt) so backfill and webhook ingests
    // of the same source revision dedupe onto the same row.
    const k1 = computeIdempotencyKey('github://acme/demo/issue/42', '2026-05-04T10:00:00Z');
    const k2 = computeIdempotencyKey('github://acme/demo/issue/43', '2026-05-04T10:00:00Z');
    expect(k1).not.toBe(k2);

    // Same artifact + same updated_at: same key (so backfill + later webhook of
    // same revision collapse to one log row).
    const k3 = computeIdempotencyKey('github://acme/demo/issue/42', '2026-05-04T10:00:00Z');
    expect(k3).toBe(k1);

    // Same artifact + different updated_at (an edit): different key.
    const k4 = computeIdempotencyKey('github://acme/demo/issue/42', '2026-05-04T11:00:00Z');
    expect(k4).not.toBe(k1);

    // Null updated_at + missing updated_at fold to the same empty-string key.
    const kNull = computeIdempotencyKey('github://acme/demo/issue/42', null);
    const kUndef = computeIdempotencyKey('github://acme/demo/issue/42', undefined);
    expect(kNull).toBe(kUndef);
  });

  it('8. race rollback verification: only the OTHER worker memory remains after the lost write', async () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const { loser: result, winner } = await ingestBehindAnotherWorker(root, {
      event,
      rawBody,
      deliveryId: 'd-this-worker',
    });
    const otherWorkerMemoryId = winner.memoryId;

    expect(result.status).toBe('skipped_duplicate');

    // Exactly ONE memory row matching the artifact_ref: this worker's was
    // rolled back with its write scope, only the other worker's row survives.
    const db = openHippoDb(root);
    try {
      // SAFETY: the SELECT explicitly lists id, so the row shape matches.
      const rows = db
        .prepare(`SELECT id FROM memories WHERE artifact_ref = ?`)
        .all('github://acme/demo/issue/42') as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(otherWorkerMemoryId);
    } finally {
      closeHippoDb(db);
    }
  });
});
