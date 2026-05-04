import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { remember, recall, type Context } from '../src/api.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { handleCommentDeleted } from '../src/connectors/github/deletion.js';

const ARTIFACT = 'github://acme/repo/issue/42/comment/123';
const SCOPE_PUBLIC = 'github:public:acme/repo';
const SCOPE_PRIVATE = 'github:private:acme/secret';

const ctxFor = (root: string, tenantId = 'default'): Context => ({
  hippoRoot: root,
  tenantId,
  actor: 'connector:github',
});

interface SeedOpts {
  tenantId?: string;
  artifactRef?: string;
  scope?: string;
  kind?: 'raw' | 'distilled';
  content: string;
}

function seedMemory(root: string, opts: SeedOpts): string {
  const ctx = ctxFor(root, opts.tenantId ?? 'default');
  const result = remember(ctx, {
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
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-del-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('1. archives a single matching raw row', () => {
    const id = seedMemory(root, { content: 'comment body v1' });

    const result = handleCommentDeleted(ctxFor(root), {
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

  it('2. archives ALL raw rows sharing artifact_ref (edit history)', () => {
    const id1 = seedMemory(root, { content: 'edit v1' });
    const id2 = seedMemory(root, { content: 'edit v2' });
    const id3 = seedMemory(root, { content: 'edit v3' });

    const result = handleCommentDeleted(ctxFor(root), {
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

  it('3. cross-tenant: deletion under tenant A does not touch tenant B row', () => {
    const idA = seedMemory(root, { content: 'tenant A comment', tenantId: 'a' });
    const idB = seedMemory(root, { content: 'tenant B comment', tenantId: 'b' });

    const result = handleCommentDeleted(ctxFor(root, 'a'), {
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

  it('4. cross-kind: only archives kind=raw, leaves distilled alone', () => {
    const rawId = seedMemory(root, { content: 'the raw row', kind: 'raw' });
    const distilledId = seedMemory(root, {
      content: 'the distilled row',
      kind: 'distilled',
    });

    const result = handleCommentDeleted(ctxFor(root), {
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

  it('5. missing memory: returns archive_skipped_not_found and marks key seen', () => {
    const result = handleCommentDeleted(ctxFor(root), {
      artifactRef: 'github://acme/repo/issue/999/comment/never',
      idempotencyKey: 'idem-missing',
      deliveryId: 'd-missing',
      eventName: 'issue_comment',
    });

    expect(result.status).toBe('archive_skipped_not_found');
    expect(result.archivedCount).toBe(0);

    // Replay returns 'duplicate' because key was marked seen.
    const replay = handleCommentDeleted(ctxFor(root), {
      artifactRef: 'github://acme/repo/issue/999/comment/never',
      idempotencyKey: 'idem-missing',
      deliveryId: 'd-missing',
      eventName: 'issue_comment',
    });
    expect(replay.status).toBe('duplicate');
  });

  it('6. duplicate delivery: second call returns duplicate, no double-archive', () => {
    const id = seedMemory(root, { content: 'dup target' });

    const first = handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-dup',
      deliveryId: 'd-dup',
      eventName: 'issue_comment',
    });
    expect(first.status).toBe('archived');
    expect(first.archivedCount).toBe(1);

    const archCountAfterFirst = archiveRowCount(root, id);
    expect(archCountAfterFirst).toBe(1);

    const second = handleCommentDeleted(ctxFor(root), {
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

  it('7. already-archived (re-deletion attempt with new key): no rows match', () => {
    seedMemory(root, { content: 'first delete target' });

    const first = handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-1',
      deliveryId: 'd-redel-1',
      eventName: 'issue_comment',
    });
    expect(first.status).toBe('archived');

    // New key, same artifactRef. No raw rows remain -> archive_skipped_not_found.
    const second = handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-2',
      deliveryId: 'd-redel-2',
      eventName: 'issue_comment',
    });
    expect(second.status).toBe('archive_skipped_not_found');
    expect(second.archivedCount).toBe(0);

    // The new key is now marked seen -> a third attempt with same key is duplicate.
    const third = handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-redel-2',
      deliveryId: 'd-redel-2',
      eventName: 'issue_comment',
    });
    expect(third.status).toBe('duplicate');
  });

  it('8. archived private-scope content does not surface via no-scope recall', () => {
    const distinctive = 'octopus-canary-token-zaqxsw';
    seedMemory(root, {
      content: distinctive,
      scope: SCOPE_PRIVATE,
    });

    // Pre-condition: scoped recall finds it (sanity).
    const before = recall(ctxFor(root), { query: distinctive, scope: SCOPE_PRIVATE });
    expect(before.results.some((r) => r.content.includes(distinctive))).toBe(true);

    // Archive via deletion.
    const result = handleCommentDeleted(ctxFor(root), {
      artifactRef: ARTIFACT,
      idempotencyKey: 'idem-private',
      deliveryId: 'd-private',
      eventName: 'pull_request_review_comment',
    });
    expect(result.status).toBe('archived');

    // Post-condition: no-scope recall returns nothing matching the canary.
    const after = recall(ctxFor(root), { query: distinctive });
    expect(after.results.some((r) => r.content.includes(distinctive))).toBe(false);

    // Also confirm the row is gone from memories entirely.
    const remaining = loadAllEntries(root).filter((e) => e.content.includes(distinctive));
    expect(remaining).toHaveLength(0);
  });
});
