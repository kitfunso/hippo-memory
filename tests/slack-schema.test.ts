import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('schema v17 — slack ingestion tables', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-schema-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates slack_event_log with PRIMARY KEY on event_id', () => {
    const db = openHippoDb(root);
    try {
      const cols = db.prepare(`PRAGMA table_info(slack_event_log)`).all() as Array<Record<string, unknown>>;
      const eventIdCol = cols.find((c) => c.name === 'event_id');
      expect(eventIdCol).toBeDefined();
      expect(eventIdCol!.pk).toBe(1);
      // Re-insert same event_id must throw (PK uniqueness).
      db.prepare(`INSERT INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`).run('E1', '2026-04-29T00:00:00Z', 'm1');
      expect(() =>
        db.prepare(`INSERT INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`).run('E1', '2026-04-29T00:00:01Z', 'm2'),
      ).toThrow();
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates slack_cursors keyed on (tenant_id, channel_id)', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO slack_cursors (tenant_id, channel_id, latest_ts, updated_at) VALUES (?, ?, ?, ?)`).run('default', 'C1', '1700000000.000000', '2026-04-29T00:00:00Z');
      // Same composite key collides; INSERT OR REPLACE supported.
      expect(() =>
        db.prepare(`INSERT INTO slack_cursors (tenant_id, channel_id, latest_ts, updated_at) VALUES (?, ?, ?, ?)`).run('default', 'C1', '1700000001.000000', '2026-04-29T00:00:01Z'),
      ).toThrow();
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates slack_dlq with autoincrementing id and received_at', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO slack_dlq (tenant_id, raw_payload, error, received_at) VALUES (?, ?, ?, ?)`).run('default', '{}', 'parse error', '2026-04-29T00:00:00Z');
      const row = db.prepare(`SELECT id FROM slack_dlq LIMIT 1`).get() as { id: number };
      expect(row.id).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates slack_workspaces with team_id PK', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`).run('T_ACME', 'acme', '2026-04-29T00:00:00Z');
      expect(() =>
        db.prepare(`INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`).run('T_ACME', 'other', '2026-04-29T00:00:01Z'),
      ).toThrow();
    } finally {
      closeHippoDb(db);
    }
  });
});
