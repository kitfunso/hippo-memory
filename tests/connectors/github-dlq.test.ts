import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parkInDlq, listDlq } from '../../src/surface/connectors/dlq.js';
import {
  githubDlq,
  replayGithubDlqEntry,
  type DlqBucket,
  type IngestHook,
} from '../../src/surface/connectors/github/dlq.js';
import type { ConnectorContext } from '../../src/surface/connectors/ingest.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('github DLQ', () => {
  let root: string;
  let ctx: FullContext;

  beforeEach(() => {
    root = makeRoot('github-dlq');
    ctx = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parkInDlq round-trips all rich metadata fields', async () => {
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{"action":"opened"}',
      error: 'parse fail',
      bucket: 'parse_error',
      eventName: 'issues',
      deliveryId: 'aaaa-bbbb',
      signature: 'sha256=deadbeef',
      installationId: '12345',
      repoFullName: 'octo/repo',
    });
    expect(id).toBe(1);
    const item = (
      await sqliteStore(root).connectorEvents.deadLetters('github', 'default', {
        id,
      })
    )[0];
    expect(item).toBeDefined();
    expect(item!.tenantId).toBe('default');
    expect(item!.rawPayload).toBe('{"action":"opened"}');
    expect(item!.error).toBe('parse fail');
    expect(item!.eventName).toBe('issues');
    expect(item!.deliveryId).toBe('aaaa-bbbb');
    expect(item!.signature).toBe('sha256=deadbeef');
    expect(item!.installationId).toBe('12345');
    expect(item!.repoFullName).toBe('octo/repo');
    expect(item!.retryCount).toBe(0);
    expect(item!.bucket).toBe('parse_error');
    expect(item!.retriedAt).toBeNull();
    expect(item!.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parkInDlq stores tenantId null as the __unroutable__ sentinel', async () => {
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: null,
      rawPayload: '{}',
      error: 'no tenant',
      bucket: 'unroutable',
    });
    const item = (await sqliteStore(root).connectorEvents.deadLetters('github', '__unroutable__', { id }))[0];
    expect(item!.tenantId).toBe('__unroutable__');
    expect(item!.bucket).toBe('unroutable');
    const listed = await listDlq(githubDlq, sqliteStore(root), {
      tenantId: '__unroutable__',
    });
    expect(listed).toHaveLength(1);
  });

  it('parkInDlq round-trips every defined bucket value', async () => {
    const buckets: DlqBucket[] = ['parse_error', 'unroutable', 'signature_failed', 'unhandled'];
    for (const bucket of buckets) {
      await parkInDlq(githubDlq, sqliteStore(root), {
        tenantId: 'default',
        rawPayload: `{"b":"${bucket}"}`,
        error: bucket,
        bucket,
      });
    }
    const items = await listDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
    });
    expect(items).toHaveLength(4);
    const observed = items.map((i) => i.bucket).sort();
    expect(observed).toEqual([...buckets].sort());
  });

  it('parkInDlq lists a host_mismatch row back under its own bucket', async () => {
    await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'host_mismatch: X-GitHub-Enterprise-Host=(none); GITHUB_ENTERPRISE_URL names ghes.example.com',
      bucket: 'host_mismatch',
    });
    const items = await listDlq(githubDlq, sqliteStore(root), { tenantId: 'default' });
    expect(items.map((i) => i.bucket)).toEqual(['host_mismatch']);
  });

  it('listDlq filters by tenant and orders by received_at ASC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{"i":1}',
      error: 'first',
    });
    // A later clock makes received_at differ without a sleep.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{"i":2}',
      error: 'second',
    });
    await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'acme',
      rawPayload: '{"i":3}',
      error: 'other tenant',
    });

    const defaults = await listDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
    });
    expect(defaults).toHaveLength(2);
    expect(defaults[0].error).toBe('first');
    expect(defaults[1].error).toBe('second');

    const acme = await listDlq(githubDlq, sqliteStore(root), {
      tenantId: 'acme',
    });
    expect(acme).toHaveLength(1);
    expect(acme[0].error).toBe('other tenant');
  });

  it('listDlq honors limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await parkInDlq(githubDlq, sqliteStore(root), {
        tenantId: 'default',
        rawPayload: `{"i":${i}}`,
        error: `e${i}`,
      });
    }
    const items = await listDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      limit: 2,
    });
    expect(items).toHaveLength(2);
  });

  it('dlqEntry returns the row by id and null for unknown ids', async () => {
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'boom',
    });
    const found = (
      await sqliteStore(root).connectorEvents.deadLetters('github', 'default', {
        id,
      })
    )[0];
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
    expect(
      await sqliteStore(root).connectorEvents.deadLetters('github', 'default', {
        id: 9999,
      }),
    ).toEqual([]);
  });

  it("reads and counts a retry on the caller's own rows only, so another tenant's id answers absent and stays unmarked", async () => {
    const events = sqliteStore(root).connectorEvents;
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: '{}',
      error: 'boom',
    });
    expect(await events.deadLetters('github', 'other-tenant', { id })).toEqual([]);
    await events.markDeadLetterRetried('github', 'other-tenant', id);
    expect((await events.deadLetters('github', 'default', { id }))[0]?.retryCount).toBe(0);
  });

  it('replayGithubDlqEntry returns not_found for unknown ids', async () => {
    const result = await replayGithubDlqEntry(ctx, 9999);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(result.memoryId).toBeNull();
    expect(result.retryCount).toBe(0);
  });

  it('replayGithubDlqEntry on parse-error payload bumps retry_count and reports parse_error', async () => {
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: 'not-json{{{',
      error: 'original parse fail',
      bucket: 'parse_error',
    });

    const result = await replayGithubDlqEntry(ctx, id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('parse_error');
    expect(result.retryCount).toBe(1);

    const after = (
      await sqliteStore(root).connectorEvents.deadLetters('github', 'default', {
        id,
      })
    )[0];
    expect(after!.retryCount).toBe(1);
    expect(after!.retriedAt).not.toBeNull();
  });

  it("replayGithubDlqEntry finds an unroutable row and counts the retry on it, but answers not_found for another tenant's row", async () => {
    const store = sqliteStore(root);
    const unroutable = await parkInDlq(githubDlq, store, {
      tenantId: null,
      rawPayload: 'x{',
      error: 'no tenant',
    });
    const acmes = await parkInDlq(githubDlq, store, {
      tenantId: 'acme',
      rawPayload: 'x{',
      error: 'acme row',
    });

    expect(await replayGithubDlqEntry(ctx, unroutable)).toMatchObject({
      status: 'parse_error',
      retryCount: 1,
    });
    expect(
      (
        await store.connectorEvents.deadLetters('github', '__unroutable__', {
          id: unroutable,
        })
      )[0]?.retryCount,
    ).toBe(1);
    expect(await replayGithubDlqEntry(ctx, acmes)).toMatchObject({
      status: 'not_found',
      retryCount: 0,
    });
    expect((await store.connectorEvents.deadLetters('github', 'acme', { id: acmes }))[0]?.retryCount).toBe(0);
  });

  function routeInstallation(installationId: string, tenantId: string): void {
    const db = openHippoDb(root);
    try {
      db.prepare('INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)').run(
        installationId,
        tenantId,
        '2026-01-01T00:00:00.000Z',
      );
    } finally {
      closeHippoDb(db);
    }
  }

  const envelope = (installationId: number, repo: string): string =>
    JSON.stringify({
      action: 'opened',
      repository: { full_name: repo },
      installation: { id: installationId },
    });

  function parkEnvelope(body: string, columns: { installationId: string; repoFullName: string }): Promise<number> {
    return parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: body,
      error: 'unroutable',
      bucket: 'unroutable',
      eventName: 'issues',
      deliveryId: 'd-1',
      ...columns,
    });
  }

  function recordingHook() {
    const seen: ConnectorContext[] = [];
    const ingestHook: IngestHook = async (hookCtx) => {
      seen.push(hookCtx);
      return { memoryId: 'mem-1' };
    };
    return { ingestHook, seen };
  }

  const retryCountOf = async (id: number): Promise<number | undefined> =>
    (await sqliteStore(root).connectorEvents.deadLetters('github', 'default', { id }))[0]?.retryCount;

  it("replays into the tenant today's routes name for the payload's installation, under the caller's actor", async () => {
    routeInstallation('42', 'acme');
    const id = await parkEnvelope(envelope(42, 'octo/repo'), { installationId: '42', repoFullName: 'octo/repo' });
    const { ingestHook, seen } = recordingHook();

    const result = await replayGithubDlqEntry(ctx, id, { ingestHook });

    expect(result).toMatchObject({ ok: true, status: 'replayed', memoryId: 'mem-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tenantId).toBe('acme');
    expect(seen[0]?.actor).toBe(ctx.actor);
  });

  it('routes from the payload, not from the columns a raw park took by regex', async () => {
    routeInstallation('42', 'acme');
    const id = await parkEnvelope(envelope(42, 'octo/repo'), { installationId: '7', repoFullName: 'fork/repo' });
    const { ingestHook, seen } = recordingHook();

    await replayGithubDlqEntry(ctx, id, { ingestHook });

    expect(seen.map((c) => c.tenantId)).toEqual(['acme']);
  });

  it("leaves a row unroutable when routes exist and none match, naming the payload's installation and repository", async () => {
    routeInstallation('7', 'acme');
    const id = await parkEnvelope(envelope(42, 'octo/repo'), { installationId: '42', repoFullName: 'octo/repo' });
    const { ingestHook, seen } = recordingHook();

    const result = await replayGithubDlqEntry(ctx, id, { ingestHook });

    expect(result).toMatchObject({ ok: false, status: 'unroutable', retryCount: 1 });
    expect(result.reason).toContain('42');
    expect(result.reason).toContain('octo/repo');
    expect(seen).toEqual([]);
    expect(await retryCountOf(id)).toBe(1);
  });

  it("replays an unmatched row into the caller's tenant when the unknown-installation fallback is set", async () => {
    routeInstallation('7', 'acme');
    const id = await parkEnvelope(envelope(42, 'octo/repo'), { installationId: '42', repoFullName: 'octo/repo' });
    const { ingestHook, seen } = recordingHook();

    const result = await replayGithubDlqEntry(ctx, id, { ingestHook, allowUnknownInstallationFallback: true });

    expect(result).toMatchObject({ ok: true, status: 'replayed' });
    expect(seen.map((c) => c.tenantId)).toEqual(['default']);
  });

  it('answers unroutable on a dry run, not replayed, for a row no route matches', async () => {
    routeInstallation('7', 'acme');
    const id = await parkEnvelope(envelope(42, 'octo/repo'), { installationId: '42', repoFullName: 'octo/repo' });

    const result = await replayGithubDlqEntry(ctx, id);

    expect(result).toMatchObject({ ok: false, status: 'unroutable' });
  });
});
