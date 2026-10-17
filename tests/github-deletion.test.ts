import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { remember, retrieve } from '../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { handleCommentDeleted } from '../src/connectors/github/deletion.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

const ARTIFACT = 'github://acme/repo/issue/42/comment/123';
const SCOPE_PUBLIC = 'github:public:acme/repo';
const SCOPE_PRIVATE = 'github:private:acme/secret';

const ctxFor = (root: string, tenantId = 'default'): FullContext => (apiCtx(root, tenantId, { subject: 'connector:github', role: 'admin' }));

interface SeedOptions {
  tenantId?: string;
  artifactRef?: string;
  scope?: string;
  kind?: 'raw' | 'distilled';
  content: string;
}

async function seedMemory(root: string, opts: SeedOptions): Promise<string> {
  const ctx = ctxFor(root, opts.tenantId ?? 'default');
  const result = await remember(ctx, {
    content: opts.content,
    kind: opts.kind ?? 'raw',
    scope: opts.scope ?? SCOPE_PUBLIC,
    artifactRef: opts.artifactRef ?? ARTIFACT,
  });
  return result.id;
}

function rawRowExists(root: string, id: string): boolean {
  const db = openHippoDb(root);
  try {
    const row = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(id);
    return !!row;
  } finally {
    closeHippoDb(db);
  }
}

function archiveRowCount(root: string, memoryId: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: the query always selects a single `SELECT COUNT(*) as c` aggregate,
    // so the driver always returns one row shaped { c: number }.
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM raw_archive WHERE memory_id = ?`)
      .get(memoryId) as { c: number };
    return Number(row.c);
  } finally {
    closeHippoDb(db);
  }
}

describe('handleCommentDeleted', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('gh-del');
  });

  it('1. archives a single matching raw row', async () => {
    const id = await seedMemory(root, { content: 'comment body v1' });

    const result = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-1',
      deliveryId: 'd-1',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archived');
    expect(result.archivedCount).toBe(1);
    expect(rawRowExists(root, id)).toBe(false);
    expect(archiveRowCount(root, id)).toBe(1);
  });

  it('2. archives ALL raw rows sharing artifact_ref (edit history)', async () => {
    const id1 = await seedMemory(root, { content: 'edit v1' });
    const id2 = await seedMemory(root, { content: 'edit v2' });
    const id3 = await seedMemory(root, { content: 'edit v3' });

    const result = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-edit',
      deliveryId: 'd-edit',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archived');
    expect(result.archivedCount).toBe(3);
    expect(rawRowExists(root, id1)).toBe(false);
    expect(rawRowExists(root, id2)).toBe(false);
    expect(rawRowExists(root, id3)).toBe(false);
    expect(archiveRowCount(root, id1)).toBe(1);
    expect(archiveRowCount(root, id2)).toBe(1);
    expect(archiveRowCount(root, id3)).toBe(1);
  });

  it('3. cross-tenant: deletion under tenant A does not touch tenant B row', async () => {
    const idA = await seedMemory(root, { content: 'tenant A comment', tenantId: 'a' });
    const idB = await seedMemory(root, { content: 'tenant B comment', tenantId: 'b' });

    const result = await handleCommentDeleted(ctxFor(root, 'a'), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-a',
      deliveryId: 'd-a',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archived');
    expect(result.archivedCount).toBe(1);
    expect(rawRowExists(root, idA)).toBe(false);
    // Tenant B row survives.
    expect(rawRowExists(root, idB)).toBe(true);
    expect(archiveRowCount(root, idB)).toBe(0);
  });

  it('4. cross-kind: only archives kind=raw, leaves distilled alone', async () => {
    const rawId = await seedMemory(root, { content: 'the raw row', kind: 'raw' });
    const distilledId = await seedMemory(root, {
      content: 'the distilled row',
      kind: 'distilled',
    });

    const result = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-kind',
      deliveryId: 'd-kind',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archived');
    expect(result.archivedCount).toBe(1);
    expect(rawRowExists(root, rawId)).toBe(false);
    expect(rawRowExists(root, distilledId)).toBe(true);
  });

  it('5. missing memory: returns archive_skipped_not_found and marks key seen', async () => {
    const result = await handleCommentDeleted(ctxFor(root), {
      artifactRef: 'github://acme/repo/issue/999/comment/never',
      idempotencyKey: 'idem-missing',
      deliveryId: 'd-missing',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archive_skipped_not_found');
    expect(result.archivedCount).toBe(0);

    // Replay returns 'duplicate' because key was marked seen.
    const replay = await handleCommentDeleted(ctxFor(root), {
      artifactRef: 'github://acme/repo/issue/999/comment/never',
      idempotencyKey: 'idem-missing',
      deliveryId: 'd-missing',
      eventName: 'issue_comment',
    });
    expect(replay.status).toBe('duplicate');
  });

  it('6. duplicate delivery: second call returns duplicate, no double-archive', async () => {
    const id = await seedMemory(root, { content: 'dup target' });

    const first = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-dup',
      deliveryId: 'd-dup',
      eventName: 'issue_comment',
    });
    expect(first.status).toBe('archived');
    expect(first.archivedCount).toBe(1);

    const archCountAfterFirst = archiveRowCount(root, id);
    expect(archCountAfterFirst).toBe(1);

    const second = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-dup',
      deliveryId: 'd-dup',
      eventName: 'issue_comment',
    });
    expect(second.status).toBe('duplicate');
    expect(second.archivedCount).toBe(0);

    // raw_archive count unchanged.
    expect(archiveRowCount(root, id)).toBe(1);
  });

  it('7. already-archived (re-deletion attempt with new key): no rows match', async () => {
    await seedMemory(root, { content: 'first delete target' });

    const first = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-1',
      deliveryId: 'd-redel-1',
      eventName: 'issue_comment',
    });
    expect(first.status).toBe('archived');

    // New key, same artifactRef. No raw rows remain -> archive_skipped_not_found.
    const second = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-2',
      deliveryId: 'd-redel-2',
      eventName: 'issue_comment',
    });
    expect(second.status).toBe('archive_skipped_not_found');
    expect(second.archivedCount).toBe(0);

    // The new key is now marked seen -> a third attempt with same key is duplicate.
    const third = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-2',
      deliveryId: 'd-redel-2',
      eventName: 'issue_comment',
    });
    expect(third.status).toBe('duplicate');
  });

  it('8. archived private-scope content does not surface via no-scope recall', async () => {
    const distinctive = 'octopus-canary-token-zaqxsw';
    await seedMemory(root, {
      content: distinctive,
      scope: SCOPE_PRIVATE,
    });

    // Pre-condition: scoped recall finds it (sanity).
    const before = await retrieve(ctxFor(root), { query: distinctive, filter: { scope: SCOPE_PRIVATE } });
    expect(before.results.some((r) => r.content.includes(distinctive))).toBe(true);

    // Archive via deletion.
    const result = await handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-private',
      deliveryId: 'd-private',
      eventName: 'pull_request_review_comment',
    });
    expect(result.status).toBe('archived');

    // Post-condition: no-scope recall returns nothing matching the canary.
    const after = await retrieve(ctxFor(root), { query: distinctive });
    expect(after.results.some((r) => r.content.includes(distinctive))).toBe(false);

    // Also confirm the row is gone from memories entirely.
    const remaining = loadAllEntries(root, 'default').filter((e) => e.content.includes(distinctive));
    expect(remaining).toHaveLength(0);
  });
});
