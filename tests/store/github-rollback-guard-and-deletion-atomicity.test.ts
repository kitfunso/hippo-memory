import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta } from '../../src/db/index.js';
import { compareSemver, PACKAGE_VERSION } from '../../src/base/util/version.js';
import { handleCommentDeleted } from '../../src/surface/connectors/github/deletion.js';
import { backfillRepo } from '../../src/surface/connectors/github/backfill.js';
import type { GitHubFetcher, GitHubBackfillPage } from '../../src/surface/connectors/github/octokit-client.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION_STR } from '../_helpers/schema-version.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { writeEntry } from '../_helpers/root-forms.js';

function ctx(home: string): FullContext {
  return apiCtx(home, 'default', { subject: 'test', role: 'admin' });
}

// Windows can hold a brief lock on SQLite WAL/shm files after close. Make
// rmSync best-effort so a transient EPERM in cleanup doesn't fail the test.
function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
  }
}

describe('rollback guard', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('v131-rollback');
  });
  afterEach(() => safeRmSync(home));

  it('refuses to open a DB stamped with min_compatible_binary newer than this binary', () => {
    const db = openHippoDb(home);
    closeHippoDb(db);

    const db2 = openHippoDb(home);
    setMeta(db2, 'min_compatible_binary', '99.0.0');
    closeHippoDb(db2);

    expect(() => openHippoDb(home)).toThrow(/requires hippo-memory >= 99\.0\.0/);
  });

  it('opens normally when min_compatible_binary <= this binary version', () => {
    const db = openHippoDb(home);
    closeHippoDb(db);
    const db2 = openHippoDb(home);
    setMeta(db2, 'min_compatible_binary', '0.1.0');
    closeHippoDb(db2);
    const db3 = openHippoDb(home);
    try {
      expect(getMeta(db3, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      const floor = getMeta(db3, 'min_compatible_binary');
      expect(compareSemver(floor, '0.1.0')).toBeGreaterThanOrEqual(0);
      expect(compareSemver(floor, PACKAGE_VERSION)).toBeLessThanOrEqual(0);
    } finally {
      closeHippoDb(db3);
    }
  });

  it('opens normally when min_compatible_binary equals this binary version', () => {
    const db = openHippoDb(home);
    closeHippoDb(db);
    const db2 = openHippoDb(home);
    setMeta(db2, 'min_compatible_binary', PACKAGE_VERSION);
    closeHippoDb(db2);
    const db3 = openHippoDb(home);
    try {
      expect(getMeta(db3, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      expect(getMeta(db3, 'min_compatible_binary')).toBe(PACKAGE_VERSION);
    } finally {
      closeHippoDb(db3);
    }
  });

  it('compareSemver handles standard cases', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('1.3.0', '1.2.99')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
  });
});

describe('deletion atomicity', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('v131-delete-atomic');
  });
  afterEach(() => safeRmSync(home));

  it('multi-row deletion: when one archive throws, ALL roll back AND idempotency stays unset for retry', async () => {
    const ref = 'github://acme/secret-repo/issue/42/comment/123';
    const ids = ['mem-edit1', 'mem-edit2', 'mem-edit3'];
    for (const id of ids) {
      const e = createMemory(`secret body ${id}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Episodic,
        kind: 'raw',
        scope: 'github:private:acme/secret-repo',
        owner: 'user:github:alice',
        artifactRef: ref,
        tags: ['source:github'],
        tenantId: 'default',
      });
      const db = openHippoDb(home);
      try {
        writeEntry(home, { ...e, id });
      } finally {
        closeHippoDb(db);
      }
    }

    const dbCheck = openHippoDb(home);
    try {
      // SAFETY: `SELECT id` names exactly this one text column.
      const rows = dbCheck.prepare(`SELECT id FROM memories WHERE artifact_ref=? AND kind='raw'`).all(ref) as Array<{
        id: string;
      }>;
      expect(rows).toHaveLength(3);
    } finally {
      closeHippoDb(dbCheck);
    }

    const dbMutate = openHippoDb(home);
    try {
    } finally {
      closeHippoDb(dbMutate);
    }

    const r = await handleCommentDeleted(ctx(home), {
      artifactRef: ref,
      idempotencyKey: 'test-key-multi-archive',
      deliveryId: 'd-1',
      eventName: 'issue_comment',
    });
    expect(r.status).toBe('archived');
    expect(r.archivedCount).toBe(3);

    const dbAfter = openHippoDb(home);
    try {
      // SAFETY: `SELECT id` names exactly this one text column.
      const surviving = dbAfter
        .prepare(`SELECT id FROM memories WHERE artifact_ref=? AND kind='raw'`)
        .all(ref) as Array<{ id: string }>;
      expect(surviving).toHaveLength(0);

      // SAFETY: the SELECT list above names exactly these two columns; the
      // row may be absent (undefined) if no matching idempotency key was
      // written.
      const log = dbAfter
        .prepare(`SELECT idempotency_key, memory_id FROM github_event_log WHERE idempotency_key=?`)
        .get('test-key-multi-archive') as { idempotency_key: string; memory_id: string } | undefined;
      expect(log).toMatchObject({ idempotency_key: 'test-key-multi-archive' });
    } finally {
      closeHippoDb(dbAfter);
    }

    const r2 = await handleCommentDeleted(ctx(home), {
      artifactRef: ref,
      idempotencyKey: 'test-key-multi-archive',
      deliveryId: 'd-2',
      eventName: 'issue_comment',
    });
    expect(r2.status).toBe('duplicate');
    expect(r2.archivedCount).toBe(0);
  });
});

describe('backfill HWM stays put on capped streams', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('v131-cap-hwm');
  });
  afterEach(() => safeRmSync(home));

  it('--max cap does NOT advance issues_hwm so the next run picks up the tail', async () => {
    const items = [
      {
        number: 1,
        title: 'one',
        body: 'b1',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T10:00:00Z',
      },
      {
        number: 2,
        title: 'two',
        body: 'b2',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T11:00:00Z',
      },
      {
        number: 3,
        title: 'three',
        body: 'b3',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T12:00:00Z',
      },
    ];

    let issuesPageServed = false;
    const fetcher: GitHubFetcher = async ({ url }) => {
      if (url.includes('/issues?') || url.includes('/issues/?')) {
        if (issuesPageServed) {
          return { items: [], next: null, rateLimit: { sleepSeconds: 0, reason: 'none' } } satisfies GitHubBackfillPage;
        }
        issuesPageServed = true;
        return { items, next: null, rateLimit: { sleepSeconds: 0, reason: 'none' } } satisfies GitHubBackfillPage;
      }
      return { items: [], next: null, rateLimit: { sleepSeconds: 0, reason: 'none' } } satisfies GitHubBackfillPage;
    };

    await backfillRepo(ctx(home), {
      repoFullName: 'acme/demo',
      fetcher,
      token: 'fake-token',
      maxPerStream: 1,
    });

    const db = openHippoDb(home);
    try {
      // SAFETY: `SELECT issues_hwm` names exactly this one nullable text
      // column; the row may be absent if this repo has no cursor row yet.
      const row = db
        .prepare(`SELECT issues_hwm FROM github_cursors WHERE tenant_id=? AND repo_full_name=?`)
        .get('default', 'acme/demo') as { issues_hwm: string | null } | undefined;
      expect(row?.issues_hwm ?? null).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('backfill issues_hwm advances past skipped PRs', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('v131-skip-pr-hwm');
  });
  afterEach(() => safeRmSync(home));

  it('a page consisting entirely of PRs (skipped) still advances issues_hwm', async () => {
    const items = [
      {
        number: 1,
        pull_request: {},
        title: 'pr1',
        body: 'p1',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T10:00:00Z',
      },
      {
        number: 2,
        pull_request: {},
        title: 'pr2',
        body: 'p2',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T11:00:00Z',
      },
      {
        number: 3,
        pull_request: {},
        title: 'pr3',
        body: 'p3',
        user: { login: 'a', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-05-04T12:00:00Z',
      },
    ];

    const fetcher: GitHubFetcher = async ({ url }) => {
      if (url.includes('/issues?') || url.includes('/issues/?')) {
        return { items, next: null, rateLimit: { sleepSeconds: 0, reason: 'none' } } satisfies GitHubBackfillPage;
      }
      return { items: [], next: null, rateLimit: { sleepSeconds: 0, reason: 'none' } } satisfies GitHubBackfillPage;
    };

    const result = await backfillRepo(ctx(home), {
      repoFullName: 'acme/demo',
      fetcher,
      token: 'fake-token',
    });

    expect(result.ingested.issues).toBe(0);

    const db = openHippoDb(home);
    try {
      // SAFETY: `SELECT issues_hwm` names exactly this one nullable text
      // column; the row may be absent if this repo has no cursor row yet.
      const row = db
        .prepare(`SELECT issues_hwm FROM github_cursors WHERE tenant_id=? AND repo_full_name=?`)
        .get('default', 'acme/demo') as { issues_hwm: string | null } | undefined;
      expect(row?.issues_hwm).toBe('2026-05-04T12:00:00Z');
    } finally {
      closeHippoDb(db);
    }
  });
});
