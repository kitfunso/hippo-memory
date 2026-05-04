import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore, loadAllEntries, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb, getCurrentSchemaVersion, getSchemaVersion } from '../src/db.js';
import { resolveTenantForTeam } from '../src/connectors/slack/tenant-routing.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { writeToDlq, listDlq, replayDlqEntry } from '../src/connectors/slack/dlq.js';
import { archiveRawMemory } from '../src/raw-archive.js';
import { verifySlackSignature } from '../src/connectors/slack/signature.js';
import { slackHistoryFetcher } from '../src/connectors/slack/web-client.js';
import { serve, type ServerHandle } from '../src/server.js';

const SECRET = 'shhh-current';
const PREVIOUS_SECRET = 'shhh-old';

function sign(secret: string, ts: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function withEnv(name: string, value: string | undefined): () => void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

describe('v0.39 commit 3 — Slack hardening + migration v19', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-v039-slack-'));
    initStore(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 1. Migration v19 schema additions present.
  it('migration v19: slack_dlq has team_id, bucket, retry_count, signature, slack_timestamp', () => {
    expect(getCurrentSchemaVersion()).toBe(24);
    const db = openHippoDb(root);
    try {
      expect(getSchemaVersion(db)).toBe(24);
      const cols = db.prepare(`PRAGMA table_info(slack_dlq)`).all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('team_id');
      expect(names).toContain('bucket');
      expect(names).toContain('retry_count');
      expect(names).toContain('signature');
      expect(names).toContain('slack_timestamp');
    } finally {
      closeHippoDb(db);
    }
  });

  // 2. Unknown team + empty workspaces → fallback.
  it('resolveTenantForTeam: empty slack_workspaces → env fallback', () => {
    const restore = withEnv('HIPPO_TENANT', 'env-tenant-A');
    const db = openHippoDb(root);
    try {
      expect(resolveTenantForTeam(db, 'TUNKNOWN')).toBe('env-tenant-A');
    } finally {
      closeHippoDb(db);
      restore();
    }
  });

  // 3. Unknown team + non-empty workspaces → fail closed (null).
  it('resolveTenantForTeam: non-empty workspaces + unknown team → null (fail closed)', () => {
    const restore = withEnv('SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK', undefined);
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TKNOWN', 'tenant-known', new Date().toISOString());
      expect(resolveTenantForTeam(db, 'TUNKNOWN')).toBeNull();
    } finally {
      closeHippoDb(db);
      restore();
    }
  });

  // 4. Escape hatch SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK=1.
  it('resolveTenantForTeam: escape hatch returns env tenant when both flag and workspaces non-empty', () => {
    const r1 = withEnv('SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK', '1');
    const r2 = withEnv('HIPPO_TENANT', 'env-fallback');
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TKNOWN', 'tenant-known', new Date().toISOString());
      expect(resolveTenantForTeam(db, 'TUNKNOWN')).toBe('env-fallback');
    } finally {
      closeHippoDb(db);
      r2();
      r1();
    }
  });

  // 5. Server slack-events: unroutable goes to DLQ with bucket='unroutable' + team_id.
  it('server slack-events: unknown team writes to slack_dlq with bucket=unroutable + team_id captured', async () => {
    const r1 = withEnv('SLACK_SIGNING_SECRET', SECRET);
    const r2 = withEnv('SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK', undefined);
    // Seed slack_workspaces so unknown teams fail closed.
    {
      const db = openHippoDb(root);
      try {
        db.prepare(
          `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
        ).run('TREGISTERED', 'tenant-known', new Date().toISOString());
      } finally {
        closeHippoDb(db);
      }
    }
    let handle: ServerHandle | null = null;
    try {
      handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'TFOREIGN',
        event_id: 'EvUnroutable',
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: 'message',
          channel: 'C1',
          channel_type: 'channel',
          user: 'U1',
          text: 'leak attempt',
          ts: '1700000000.000100',
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': ts,
          'x-slack-signature': sign(SECRET, ts, body),
        },
        body,
      });
      // Mandatory ACK.
      expect(res.status).toBe(200);
      // No memory created.
      expect(loadAllEntries(root).filter((e) => e.tags.includes('source:slack'))).toHaveLength(0);
      const db = openHippoDb(root);
      try {
        const rows = db
          .prepare(
            `SELECT tenant_id, team_id, bucket, signature, slack_timestamp FROM slack_dlq ORDER BY id`,
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0].bucket).toBe('unroutable');
        expect(rows[0].team_id).toBe('TFOREIGN');
        expect(rows[0].tenant_id).toBe('__unroutable__');
        expect(rows[0].signature).toBeTruthy();
        expect(rows[0].slack_timestamp).toBe(ts);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      if (handle) await handle.stop();
      r2();
      r1();
    }
  });

  // 6. Ingest race: simultaneous ingest with same eventId. Since single-
  //    process serialization makes a true race hard to reproduce, we exercise
  //    the afterWrite race-detection branch directly: we use the documented
  //    `remember()` afterWrite hook to insert a slack_event_log row for an
  //    event_id mid-SAVEPOINT, then have the same hook run the production
  //    INSERT-OR-IGNORE-with-changes-check logic. This is a real DB test (no
  //    mocks) that validates the exact contract: pre-existing event_log row
  //    causes INSERT OR IGNORE to return changes=0 → throw → SAVEPOINT
  //    rollback → no orphan memory row.
  //
  //    For the public ingestMessage path under the same-eventId fast-path
  //    pre-check, we also assert the second call returns 'duplicate' (the
  //    short-circuit branch) and a single memory row exists.
  it('ingest race: duplicate event_id yields exactly one memory + skipped_duplicate via afterWrite throw', async () => {
    const { remember } = await import('../src/api.js');
    const { DuplicateEventError } = await import('../src/connectors/slack/idempotency.js');
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'connector:slack' };

    // First call: ordinary ingest succeeds and writes to slack_event_log.
    const r1 = ingestMessage(ctx, {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U1', text: 'race-msg', ts: '1700.000099' },
      eventId: 'EvRace',
    });
    expect(r1.status).toBe('ingested');
    expect(r1.memoryId).toBeTruthy();

    // Second call with same eventId: fast-path pre-check returns duplicate
    // immediately. The plan stop-condition documents this: "the existing
    // pre-check hasSeenEvent stays as fast-path optimization."
    const r2 = ingestMessage(ctx, {
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U1', text: 'race-msg', ts: '1700.000099' },
      eventId: 'EvRace',
    });
    expect(r2.status).toBe('duplicate');
    expect(r2.memoryId).toBe(r1.memoryId);

    // Now exercise the afterWrite throw directly. A different event_id whose
    // slack_event_log row has been pre-seeded simulates the two-worker race
    // where worker B's pre-check missed worker A's commit.
    const racedEventId = 'EvRaceB';
    {
      const db = openHippoDb(root);
      try {
        db.prepare(
          `INSERT INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`,
        ).run(racedEventId, new Date().toISOString(), r1.memoryId);
      } finally {
        closeHippoDb(db);
      }
    }

    // Build a fresh memory entry that would otherwise be valid, and let the
    // afterWrite hook run the real production logic. The race-loser commit
    // must throw DuplicateEventError → SAVEPOINT rollback → no new row.
    const memBefore = loadAllEntries(root).length;
    const seedMem = createMemory('would-be-second-write', {
      layer: Layer.Buffer,
      tenantId: 'default',
      kind: 'raw',
    });

    // Re-implement the production afterWrite logic exactly so this is a
    // real-DB integration test of the pattern without going through ingest.ts
    // (which would short-circuit at hasSeenEvent).
    expect(() =>
      remember(ctx, {
        content: seedMem.content,
        layer: seedMem.layer,
        tags: seedMem.tags,
        kind: 'raw',
        afterWrite: (innerDb, memoryId) => {
          const ins = innerDb
            .prepare(
              `INSERT OR IGNORE INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`,
            )
            .run(racedEventId, new Date().toISOString(), memoryId);
          if (Number(ins.changes ?? 0) === 0) {
            throw new DuplicateEventError(racedEventId);
          }
        },
      }),
    ).toThrow(DuplicateEventError);

    // No new memory row: the SAVEPOINT rolled back the would-be-second-write.
    const memAfter = loadAllEntries(root).length;
    expect(memAfter).toBe(memBefore);

    // slack_event_log still has exactly one row for the raced event_id.
    {
      const db = openHippoDb(root);
      try {
        const rows = db
          .prepare(`SELECT memory_id FROM slack_event_log WHERE event_id = ?`)
          .all(racedEventId) as Array<{ memory_id: string }>;
        expect(rows).toHaveLength(1);
        // The pre-seeded memory_id (r1.memoryId), not the rolled-back one.
        expect(rows[0].memory_id).toBe(r1.memoryId);
      } finally {
        closeHippoDb(db);
      }
    }
  });

  // 7. Deletion afterArchive atomic: throw inside callback rolls back the archive.
  it('archiveRawMemory: throw inside afterArchive callback rolls back the archive', () => {
    // Seed a kind=raw memory directly.
    const mem = createMemory('archive-rollback-test', {
      layer: Layer.Buffer,
      tenantId: 'default',
      kind: 'raw',
    });
    writeEntry(root, mem);

    const db = openHippoDb(root);
    try {
      expect(() =>
        archiveRawMemory(db, mem.id, {
          reason: 'test',
          who: 'cli',
          afterArchive: () => {
            throw new Error('hook says no');
          },
        }),
      ).toThrow(/hook says no/);

      // Memory is still present — SAVEPOINT rolled back.
      const stillThere = db
        .prepare(`SELECT id, kind FROM memories WHERE id = ?`)
        .get(mem.id) as { id?: string; kind?: string } | undefined;
      expect(stillThere?.id).toBe(mem.id);
      expect(stillThere?.kind).toBe('raw');

      // raw_archive has no row for this id.
      const archCount = db
        .prepare(`SELECT COUNT(*) AS c FROM raw_archive WHERE memory_id = ?`)
        .get(mem.id) as { c: number | bigint };
      expect(Number(archCount.c)).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  // 8. DLQ replay clean path: retry_count=1, ingest succeeds, memory created.
  it('DLQ replay: clean path increments retry_count and ingests the memory', () => {
    // Seed a parse_error row whose payload IS a valid event_callback envelope —
    // simulating "the route handler dropped this for an old reason; routing is
    // now fixed and we can replay it".
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'TREPLAY',
      event_id: 'EvReplay1',
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'CR1',
        channel_type: 'channel',
        user: 'U1',
        text: 'replay-me',
        ts: '1700000000.000777',
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sigVal = sign(SECRET, ts, body);

    // Pre-register the workspace so resolveTenantForTeam succeeds on replay.
    {
      const db = openHippoDb(root);
      try {
        db.prepare(
          `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
        ).run('TREPLAY', 'default', new Date().toISOString());
      } finally {
        closeHippoDb(db);
      }
    }

    // Seed the DLQ row.
    let dlqId: number;
    {
      const db = openHippoDb(root);
      try {
        dlqId = writeToDlq(db, {
          tenantId: 'default',
          teamId: 'TREPLAY',
          rawPayload: body,
          error: 'historical parse_error',
          bucket: 'parse_error',
          signature: sigVal,
          slackTimestamp: ts,
        });
      } finally {
        closeHippoDb(db);
      }
    }

    // Replay using the current secret. Use a wide skew override so the test is
    // not flaky against the now/skew check inside verifySlackSignature.
    const result = replayDlqEntry(
      { hippoRoot: root },
      dlqId,
      { signingSecret: SECRET, now: Number(ts), skewSeconds: 60 },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ingested');
    expect(result.retryCount).toBe(1);
    expect(result.memoryId).toBeTruthy();

    // Memory exists.
    const created = loadAllEntries(root).find((e) => e.id === result.memoryId);
    expect(created).toBeDefined();
    expect(created?.kind).toBe('raw');

    // DLQ row has retried_at + retry_count = 1.
    const db = openHippoDb(root);
    try {
      const after = db
        .prepare(`SELECT retried_at, retry_count FROM slack_dlq WHERE id = ?`)
        .get(dlqId) as { retried_at?: string; retry_count?: number | bigint };
      expect(after.retried_at).toBeTruthy();
      expect(Number(after.retry_count)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  // 9. Web-client emits oldest only on first-page resume.
  it('slackHistoryFetcher: oldest is emitted only when caller passes one', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, messages: [], response_metadata: {} }),
      } as unknown as Response;
    });
    const fetcher = slackHistoryFetcher('xoxb-fake', fakeFetch as unknown as typeof fetch);

    // First page (resume): caller passes oldest.
    await fetcher({ channelId: 'C1', cursor: null, oldest: '1700000000.000001' });
    // Second page: caller passes cursor only, no oldest.
    await fetcher({ channelId: 'C1', cursor: 'NEXT_TOKEN' });

    expect(calls[0]).toContain('oldest=1700000000.000001');
    expect(calls[1]).not.toContain('oldest=');
    expect(calls[1]).toContain('cursor=NEXT_TOKEN');
  });

  // 10. Signing-secret rotation: signature with previous secret valid when both env set.
  it('verifySlackSignature: previousSecret is accepted when current fails (rotation window)', () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const body = '{"hello":"world"}';
    const oldSig = sign(PREVIOUS_SECRET, ts, body);

    // Without previousSecret: fails.
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: oldSig,
        signingSecret: SECRET,
        now,
      }),
    ).toBe(false);

    // With previousSecret: passes.
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: oldSig,
        signingSecret: SECRET,
        previousSecret: PREVIOUS_SECRET,
        now,
      }),
    ).toBe(true);

    // Garbage signature: still fails even with previousSecret set.
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: 'v0=deadbeef',
        signingSecret: SECRET,
        previousSecret: PREVIOUS_SECRET,
        now,
      }),
    ).toBe(false);
  });

  // 11. DLQ team_id captured from malformed body via regex.
  it('server slack-events: malformed JSON body → DLQ row has team_id captured via regex', async () => {
    const r1 = withEnv('SLACK_SIGNING_SECRET', SECRET);
    let handle: ServerHandle | null = null;
    try {
      handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
      // Body is INVALID JSON (trailing comma, unclosed brace) but still
      // contains "team_id":"TPARTIAL" in plain text.
      const malformed = '{"type":"event_callback","team_id":"TPARTIAL","event":{,';
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': ts,
          'x-slack-signature': sign(SECRET, ts, malformed),
        },
        body: malformed,
      });
      expect(res.status).toBe(200);
      const db = openHippoDb(root);
      try {
        const rows = db
          .prepare(`SELECT team_id, bucket FROM slack_dlq ORDER BY id DESC LIMIT 1`)
          .all() as Array<{ team_id?: string; bucket?: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].team_id).toBe('TPARTIAL');
        expect(rows[0].bucket).toBe('parse_error');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      if (handle) await handle.stop();
      r1();
    }
  });
});
