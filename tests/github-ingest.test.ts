import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { ingestEvent, type IngestEvent } from '../src/connectors/github/ingest.js';
import { computeIdempotencyKey } from '../src/connectors/github/signature.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewCommentEvent,
} from '../src/connectors/github/types.js';

// -- Test helpers ----------------------------------------------------------

const ctx = (root: string) => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: 'connector:github',
});

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

/**
 * Insert a complete memories row. Used by the race tests (5, 8) to simulate
 * a concurrent worker. We mirror upsertEntryRow's column list exactly so
 * NOT NULL constraints and the ON CONFLICT path are satisfied — the row
 * must look like any other memories row.
 */
function injectMemoryRow(db: DatabaseSyncLike, id: string, content: string, artifactRef: string): void {
  const entry = createMemory(content, {
    layer: Layer.Episodic,
    kind: 'raw',
    scope: 'github:public:acme/demo',
    owner: 'user:github:other-worker',
    artifact_ref: artifactRef,
    tags: ['source:github', 'repo:acme/demo'],
    tenantId: 'default',
  });
  db.prepare(
    `INSERT INTO memories (
      id, created, last_retrieved, retrieval_count, strength, half_life_days, layer,
      tags_json, emotional_valence, schema_fit, source, outcome_score,
      outcome_positive, outcome_negative,
      conflicts_with_json, pinned, confidence, content,
      parents_json, starred,
      trace_outcome, source_session_id,
      valid_from, superseded_by,
      extracted_from,
      dag_level, dag_parent_id,
      kind, scope, owner, artifact_ref,
      tenant_id,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    entry.created,
    entry.last_retrieved,
    entry.retrieval_count,
    entry.strength,
    entry.half_life_days,
    entry.layer,
    JSON.stringify(entry.tags),
    entry.emotional_valence,
    entry.schema_fit,
    entry.source,
    entry.outcome_score,
    entry.outcome_positive,
    entry.outcome_negative,
    JSON.stringify(entry.conflicts_with),
    entry.pinned ? 1 : 0,
    entry.confidence,
    entry.content,
    JSON.stringify(entry.parents),
    entry.starred ? 1 : 0,
    entry.trace_outcome,
    entry.source_session_id,
    entry.valid_from,
    entry.superseded_by,
    entry.extracted_from,
    entry.dag_level,
    entry.dag_parent_id,
    entry.kind,
    entry.scope,
    entry.owner,
    entry.artifact_ref,
    entry.tenantId,
  );
}

// -- Tests -----------------------------------------------------------------

describe('ingestEvent', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-ingest-'));
    initStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('1. fresh ingest: writes a kind=raw memory and stamps github_event_log', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const result = ingestEvent(ctx(root), {
      event,
      rawBody,
      deliveryId: 'd-1',
    });

    expect(result.status).toBe('ingested');
    expect(result.memoryId).toBeTruthy();

    // Memory exists with correct shape.
    const entries = loadAllEntries(root);
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
      const idempotencyKey = computeIdempotencyKey('issues', rawBody);
      const row = db
        .prepare(`SELECT idempotency_key, delivery_id, event_name, memory_id FROM github_event_log WHERE idempotency_key = ?`)
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

  it('2. duplicate fast path: same (eventName, rawBody) returns duplicate with same memoryId', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const r1 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-1' });
    expect(r1.status).toBe('ingested');

    const r2 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);

    // Still only one memory row.
    const entries = loadAllEntries(root);
    expect(entries.filter((e) => e.tags.includes('source:github'))).toHaveLength(1);
  });

  it('3. empty body skip: returns skipped, log row has memory_id=NULL, replay returns duplicate', () => {
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

    const r1 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-1' });
    expect(r1.status).toBe('skipped');
    expect(r1.memoryId).toBeNull();

    // No memory row.
    const entries = loadAllEntries(root);
    expect(entries.filter((e) => e.tags.includes('source:github'))).toHaveLength(0);

    // github_event_log row exists with memory_id=NULL.
    const db = openHippoDb(root);
    try {
      const key = computeIdempotencyKey('issues', rawBody);
      const row = db
        .prepare(`SELECT memory_id FROM github_event_log WHERE idempotency_key = ?`)
        .get(key) as { memory_id: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.memory_id).toBeNull();
    } finally {
      closeHippoDb(db);
    }

    // Replay returns 'duplicate', not 'skipped' (transform isn't re-run).
    const r2 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'd-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBeNull();
  });

  it('4. all four event types ingest with correct artifact_ref shapes', () => {
    const issuePayload = makeIssueEvent();
    const issueCommentPayload = makeIssueCommentEvent();
    const prPayload = makePullRequestEvent();
    const prReviewCommentPayload = makePrReviewCommentEvent();

    const r1 = ingestEvent(ctx(root), {
      event: { eventName: 'issues', payload: issuePayload },
      rawBody: JSON.stringify(issuePayload),
      deliveryId: 'd-1',
    });
    const r2 = ingestEvent(ctx(root), {
      event: { eventName: 'issue_comment', payload: issueCommentPayload },
      rawBody: JSON.stringify(issueCommentPayload),
      deliveryId: 'd-2',
    });
    const r3 = ingestEvent(ctx(root), {
      event: { eventName: 'pull_request', payload: prPayload },
      rawBody: JSON.stringify(prPayload),
      deliveryId: 'd-3',
    });
    const r4 = ingestEvent(ctx(root), {
      event: { eventName: 'pull_request_review_comment', payload: prReviewCommentPayload },
      rawBody: JSON.stringify(prReviewCommentPayload),
      deliveryId: 'd-4',
    });

    expect(r1.status).toBe('ingested');
    expect(r2.status).toBe('ingested');
    expect(r3.status).toBe('ingested');
    expect(r4.status).toBe('ingested');

    const entries = loadAllEntries(root);
    const refs = new Set(entries.map((e) => e.artifact_ref).filter((r): r is string => !!r));
    expect(refs.has('github://acme/demo/issue/42')).toBe(true);
    expect(refs.has('github://acme/demo/issue/42/comment/999')).toBe(true);
    expect(refs.has('github://acme/demo/pull/7')).toBe(true);
    expect(refs.has('github://acme/demo/pull/7/review_comment/12345')).toBe(true);
  });

  it('5. race via injection hook: SAVEPOINT collision rolls back, returns skipped_duplicate with other worker memoryId', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };
    const otherWorkerMemoryId = 'mem_otherworker01';

    const result = ingestEvent(ctx(root), {
      event,
      rawBody,
      deliveryId: 'd-this-worker',
      __testInjectBeforeLog: (innerDb, key) => {
        // Single-process simulation of a "worker B already committed" race.
        //
        // SQLite + WAL mode allows multiple connections but serializes
        // writers. While the ingest path holds `SAVEPOINT write_entry`, no
        // other connection can write — they wait on busy_timeout (5s) and
        // error. So we cannot simply open a second connection and INSERT.
        //
        // Instead we briefly ROLLBACK + RELEASE the outer savepoint to
        // return innerDb to autocommit, commit the other-worker rows
        // (which now persist regardless of subsequent rollbacks), then
        // RE-OPEN a fresh SAVEPOINT under the same name so the calling
        // writeEntryDbOnly's RELEASE / ROLLBACK TO statements still target
        // a valid scope. The DuplicateIdempotencyError thrown by ingest's
        // INSERT OR IGNORE then rolls back the freshly-opened (empty)
        // savepoint — leaving worker B's committed rows intact, exactly
        // as a real two-process race would leave them.
        innerDb.exec('ROLLBACK TO SAVEPOINT write_entry');
        innerDb.exec('RELEASE SAVEPOINT write_entry');
        try {
          injectMemoryRow(
            innerDb,
            otherWorkerMemoryId,
            'Other worker content for the same artifact_ref',
            'github://acme/demo/issue/42',
          );
          innerDb
            .prepare(
              `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(key, 'd-other-worker', 'issues', new Date().toISOString(), otherWorkerMemoryId);
        } finally {
          innerDb.exec('SAVEPOINT write_entry');
        }
      },
    });

    expect(result.status).toBe('skipped_duplicate');
    expect(result.memoryId).toBe(otherWorkerMemoryId);

    // The github_event_log delivery_id is the OTHER worker's, confirming
    // ingest's INSERT OR IGNORE was the loser of the race.
    const db = openHippoDb(root);
    try {
      const key = computeIdempotencyKey('issues', rawBody);
      const row = db
        .prepare(`SELECT delivery_id, memory_id FROM github_event_log WHERE idempotency_key = ?`)
        .get(key) as { delivery_id: string; memory_id: string | null } | undefined;
      expect(row?.delivery_id).toBe('d-other-worker');
      expect(row?.memory_id).toBe(otherWorkerMemoryId);
    } finally {
      closeHippoDb(db);
    }
  });

  it('6. replay defense: same body with two different deliveryIds returns duplicate on second call', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };

    const r1 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'attacker-replay-uuid-1' });
    expect(r1.status).toBe('ingested');

    // Same signed body, different (unsigned, attacker-controlled) delivery UUID.
    const r2 = ingestEvent(ctx(root), { event, rawBody, deliveryId: 'attacker-replay-uuid-2' });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);
  });

  it('7. different event names with the same body produce different idempotency keys', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);

    const k1 = computeIdempotencyKey('issues', rawBody);
    const k2 = computeIdempotencyKey('issue_comment', rawBody);
    expect(k1).not.toBe(k2);
  });

  it('8. race rollback verification: only the OTHER worker memory remains after DuplicateIdempotencyError', () => {
    const payload = makeIssueEvent();
    const rawBody = JSON.stringify(payload);
    const event: IngestEvent = { eventName: 'issues', payload };
    const otherWorkerMemoryId = 'mem_otherworker02';

    const result = ingestEvent(ctx(root), {
      event,
      rawBody,
      deliveryId: 'd-this-worker',
      __testInjectBeforeLog: (innerDb, key) => {
        // Same SAVEPOINT-cycling pattern as test 5. See test 5 for the
        // full rationale — short version: WAL serializes cross-connection
        // writers, so to simulate worker B's committed state we briefly
        // exit + re-enter the savepoint on the same connection.
        innerDb.exec('ROLLBACK TO SAVEPOINT write_entry');
        innerDb.exec('RELEASE SAVEPOINT write_entry');
        try {
          injectMemoryRow(
            innerDb,
            otherWorkerMemoryId,
            'Other worker content for the same artifact_ref',
            'github://acme/demo/issue/42',
          );
          innerDb
            .prepare(
              `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(key, 'd-other-worker', 'issues', new Date().toISOString(), otherWorkerMemoryId);
        } finally {
          innerDb.exec('SAVEPOINT write_entry');
        }
      },
    });

    expect(result.status).toBe('skipped_duplicate');

    // Exactly ONE memory row matching the artifact_ref — this worker's was
    // rolled back by the SAVEPOINT, only the other worker's pre-injected
    // row survives.
    const db = openHippoDb(root);
    try {
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
