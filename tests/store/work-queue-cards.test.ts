// W2a work-queue cards (trajectories/01M2D5VSYJFK4YXQ0RG2NGCPYJ/plan.md), tests 1,2,4-5 and 12-13 with the input checks.
// Test 3 (self-heal parity) lives in tests/db/db-continuity-tables-self-heal.test.ts's CONTINUITY_TABLES.
import { describe, it, expect } from 'vitest';
import {
  openHippoDb,
  closeHippoDb,
  getSchemaVersion,
  getCurrentSchemaVersion,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { CARD_TRANSITIONS, assertCardTransition, type CardStatus } from '../../src/base/records/card.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { cardDetailOf } from '../_helpers/card-detail.js';
import {
  createCard,
  loadCard,
  loadCardRuns,
  claimCard,
  blockCard,
  reviewCard,
  completeCard,
  addCardComment,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { root, useCardsRoot } from '../_helpers/work-queue-cards.js';

const ALL_STATUSES: CardStatus[] = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'shelved'];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columns(db: DatabaseSyncLike, table: string): ColumnInfo[] {
  // SAFETY: PRAGMA table_info always yields rows shaped like ColumnInfo.
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function indexNames(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: PRAGMA index_list always yields rows with a `name` column.
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

function countRows(db: DatabaseSyncLike, table: string): number {
  // SAFETY: COUNT(*) always returns a single row with a `c` column.
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

useCardsRoot();

describe('fresh store, single open', () => {
  useCardsRoot({ init: false });
  it('has all four card tables, the five new indexes, and schema_version 43', async () => {
    const db = openHippoDb(root);
    try {
      expect(columns(db, 'cards').map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'id',
          'title',
          'status',
          'assignee_runtime',
          'lease_until',
          'heartbeat_at',
          'tenant_id',
        ]),
      );
      expect(columns(db, 'card_deps').map((c) => c.name)).toEqual(
        expect.arrayContaining(['parent', 'child', 'tenant_id']),
      );
      expect(columns(db, 'card_runs').map((c) => c.name)).toEqual(
        expect.arrayContaining(['id', 'card', 'runtime', 'outcome']),
      );
      expect(columns(db, 'card_comments').map((c) => c.name)).toEqual(
        expect.arrayContaining(['id', 'card_id', 'author', 'body']),
      );
      expect(indexNames(db, 'cards')).toContain('idx_cards_tenant_status');
      expect(indexNames(db, 'card_deps')).toEqual(
        expect.arrayContaining(['idx_card_deps_tenant_child', 'idx_card_deps_tenant_parent']),
      );
      expect(indexNames(db, 'card_runs')).toContain('idx_card_runs_tenant_card');
      expect(indexNames(db, 'card_comments')).toContain('idx_card_comments_tenant_card');
      expect(indexNames(db, 'session_handoffs')).toContain('idx_session_handoffs_tenant_card');
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(getCurrentSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('a v42 store migrates to v43 with the four tables present, empty', () => {
  it('gains cards/card_deps/card_runs/card_comments on next open', async () => {
    initTestStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE cards; DROP TABLE card_deps; DROP TABLE card_runs; DROP TABLE card_comments;');
      db1.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('42');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getSchemaVersion(db2)).toBe(LATEST_SCHEMA_VERSION);
      expect(countRows(db2, 'cards')).toBe(0);
      expect(countRows(db2, 'card_deps')).toBe(0);
      expect(countRows(db2, 'card_runs')).toBe(0);
      expect(countRows(db2, 'card_comments')).toBe(0);
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('createCard initial status', () => {
  it('no deps -> ready', async () => {
    const card = await createCard(root, 'default', { title: 'No deps' });
    expect(card.status).toBe('ready');
  });

  it('one backlog-status dep -> backlog', async () => {
    const parent = await createCard(root, 'default', { title: 'Parent' });
    expect(parent.status).toBe('ready');
    // Force the parent to a non-done status so the child's pre-check sees a not-done parent.
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'backlog' WHERE id = ?`).run(parent.id);
    } finally {
      closeHippoDb(db);
    }
    const child = await createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });
    expect(child.status).toBe('backlog');
  });

  it('dep on an already-done parent -> ready', async () => {
    const parent = await createCard(root, 'default', { title: 'Done parent' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'done' WHERE id = ?`).run(parent.id);
    } finally {
      closeHippoDb(db);
    }
    const child = await createCard(root, 'default', { title: 'Child of done', dependsOn: [parent.id] });
    expect(child.status).toBe('ready');
  });

  it('a repeated dependsOn id is recorded once', async () => {
    const parent = await createCard(root, 'default', { title: 'Parent' });
    const child = await createCard(root, 'default', { title: 'Child', dependsOn: [parent.id, parent.id] });
    expect(child.status).toBe('backlog');
    expect((await cardDetailOf(root, 'default', child.id))?.deps.parents).toEqual([parent.id]);
  });
});

describe('status-transition matrix', () => {
  it('every (from, to) pair not in CARD_TRANSITIONS[from] throws; every pair in it does not', async () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (CARD_TRANSITIONS[from].includes(to)) {
          expect(() => assertCardTransition([from], to)).not.toThrow();
        } else {
          expect(() => assertCardTransition([from], to)).toThrow(`illegal card transition: ${from} -> ${to}`);
        }
      }
    }
  });

  it('blocked -> running is accepted via claimCard', async () => {
    const card = await createCard(root, 'default', { title: 'Blocked card' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id);
    } finally {
      closeHippoDb(db);
    }
    const claimed = await claimCard(root, 'default', card.id, 'codex');
    expect(claimed?.status).toBe('running');
  });
});

describe('unknown dependsOn pre-check', () => {
  it('throws and leaves zero rows in cards and card_deps', async () => {
    await expect(createCard(root, 'default', { title: 'x', dependsOn: ['nope'] })).rejects.toThrow(
      'unknown parent card id: nope',
    );
    const db = openHippoDb(root);
    try {
      expect(countRows(db, 'cards')).toBe(0);
      expect(countRows(db, 'card_deps')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe("addCardComment checks the card belongs to the caller's tenant", () => {
  it('throws unknown card id for a foreign-tenant card and for a missing id; happy path still works', async () => {
    const card = await createCard(root, 'default', { title: 'Commented' });

    await expect(addCardComment(root, 'tenant2', card.id, 'x', 'y')).rejects.toThrow(`unknown card id: ${card.id}`);
    await expect(addCardComment(root, 'default', 'nope', 'x', 'y')).rejects.toThrow('unknown card id: nope');

    expect((await cardDetailOf(root, 'default', card.id))?.comments).toEqual([]);
    expect(await cardDetailOf(root, 'tenant2', card.id)).toBeNull();

    const comment = await addCardComment(root, 'default', card.id, 'x', 'y');
    expect(comment.body).toBe('y');
    expect((await cardDetailOf(root, 'default', card.id))?.comments).toHaveLength(1);
  });
});

describe('claim/block/review/complete throw on an unknown card id, keep null for the wrong state', () => {
  it('claimCard throws for a nonexistent id and for a card read under another tenant', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await expect(claimCard(root, 'default', 'nope', 'r1')).rejects.toThrow('unknown card id: nope');
    await expect(claimCard(root, 'tenant2', card.id, 'r1')).rejects.toThrow(`unknown card id: ${card.id}`);
  });

  it('blockCard throws for a nonexistent id and for a card read under another tenant', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await claimCard(root, 'default', card.id, 'r1');
    await expect(blockCard(root, 'default', 'nope', 'why')).rejects.toThrow('unknown card id: nope');
    await expect(blockCard(root, 'tenant2', card.id, 'why')).rejects.toThrow(`unknown card id: ${card.id}`);
  });

  it('reviewCard throws for a nonexistent id and for a card read under another tenant', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await claimCard(root, 'default', card.id, 'r1');
    await expect(reviewCard(root, 'default', 'nope')).rejects.toThrow('unknown card id: nope');
    await expect(reviewCard(root, 'tenant2', card.id)).rejects.toThrow(`unknown card id: ${card.id}`);
  });

  it('completeCard throws for a nonexistent id and for a card read under another tenant', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await claimCard(root, 'default', card.id, 'r1');
    await reviewCard(root, 'default', card.id);
    await expect(completeCard(root, 'default', 'nope', 'success')).rejects.toThrow('unknown card id: nope');
    await expect(completeCard(root, 'tenant2', card.id, 'success')).rejects.toThrow(`unknown card id: ${card.id}`);
  });

  it('a card that exists but is in the wrong state still returns null, not throws', async () => {
    const parent = await createCard(root, 'default', { title: 'parent' });
    const backlogChild = await createCard(root, 'default', { title: 'child', dependsOn: [parent.id] });
    expect(await claimCard(root, 'default', backlogChild.id, 'r1')).toBeNull();

    const readyCard = await createCard(root, 'default', { title: 'ready-one' });
    expect(await blockCard(root, 'default', readyCard.id, 'why')).toBeNull();
    expect(await reviewCard(root, 'default', readyCard.id)).toBeNull();
  });
});

describe('createCard/claimCard/blockCard/addCardComment validate their inputs', () => {
  it('createCard throws for an empty or whitespace-only title and commits nothing', async () => {
    const db = openHippoDb(root);
    try {
      await expect(createCard(root, 'default', { title: '' })).rejects.toThrow('title must not be empty');
      await expect(createCard(root, 'default', { title: '   ' })).rejects.toThrow('title must not be empty');
      expect(countRows(db, 'cards')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('createCard throws for a budget that is not a positive integer and commits nothing', async () => {
    const db = openHippoDb(root);
    try {
      await expect(createCard(root, 'default', { title: 'x', budget: 0 })).rejects.toThrow(
        'Invalid budget: 0 (expected a positive integer)',
      );
      await expect(createCard(root, 'default', { title: 'x', budget: -3 })).rejects.toThrow(
        'Invalid budget: -3 (expected a positive integer)',
      );
      await expect(createCard(root, 'default', { title: 'x', budget: 2.5 })).rejects.toThrow(
        'Invalid budget: 2.5 (expected a positive integer)',
      );
      expect(countRows(db, 'cards')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('claimCard throws for an empty runtime and leaves the card unclaimed', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await expect(claimCard(root, 'default', card.id, '')).rejects.toThrow('runtime must not be empty');
    expect((await loadCard(root, 'default', card.id))?.status).toBe('ready');
    expect(await loadCardRuns(root, 'default', card.id)).toEqual([]);
  });

  it('blockCard throws for an empty reason and leaves the card running with no comment', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await claimCard(root, 'default', card.id, 'r1');
    await expect(blockCard(root, 'default', card.id, '')).rejects.toThrow('reason must not be empty');
    expect((await loadCard(root, 'default', card.id))?.status).toBe('running');
    expect((await cardDetailOf(root, 'default', card.id))?.comments).toEqual([]);
  });

  it('addCardComment throws for an empty body and adds no comment', async () => {
    const card = await createCard(root, 'default', { title: 'x' });
    await expect(addCardComment(root, 'default', card.id, 'author', '')).rejects.toThrow('body must not be empty');
    expect((await cardDetailOf(root, 'default', card.id))?.comments).toEqual([]);
  });
});
