import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, readEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { remember, recall, forget, promote, supersede } from '../src/api.js';

describe('api domain — recall/forget/promote/supersede', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-api-dom-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-api-glob-'));
    initStore(home);
    initStore(globalHome);
    // Pin the global store to our tmpdir for promote().
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
  });

  afterEach(() => {
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('recall returns BM25 candidates and audits with the supplied actor', () => {
    remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'recall-canary alpha-token sentinel' },
    );
    remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'unrelated content for noise' },
    );

    const result = recall(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_recall' },
      { query: 'alpha-token' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.content).toContain('alpha-token');
    expect(result.results[0]!.id).toMatch(/^mem_/);
    expect(result.total).toBeGreaterThan(0);
    expect(result.tokens).toBeGreaterThan(0);

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events[0]!.actor).toBe('api_key:hk_recall');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget deletes the row and audits with the supplied actor', () => {
    const { id } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'forget-me-please' },
    );
    expect(readEntry(home, id)?.id).toBe(id);

    const result = forget(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_forget' },
      id,
    );
    expect(result).toEqual({ ok: true, id });
    expect(readEntry(home, id)).toBeNull();

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      // The api.forget event lands AFTER the cli-default audit emit from
      // deleteEntry, so DESC ordering returns ours first (matches Task 1
      // shape; Task 4 will dedupe).
      expect(events[0]!.actor).toBe('api_key:hk_forget');
      expect(events[0]!.targetId).toBe(id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('promote copies a memory into the global store and audits with the supplied actor', () => {
    const { id } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'promote-me-to-global' },
    );

    const result = promote(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_promote' },
      id,
    );
    expect(result.ok).toBe(true);
    expect(result.sourceId).toBe(id);
    expect(result.globalId).toMatch(/^g_/);

    // Global copy exists with new id.
    const globalEntry = readEntry(globalHome, result.globalId);
    expect(globalEntry?.content).toBe('promote-me-to-global');

    const db = openHippoDb(globalHome);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'promote' });
      expect(events[0]!.actor).toBe('api_key:hk_promote');
      expect(events[0]!.targetId).toBe(result.globalId);
      expect(events[0]!.metadata).toMatchObject({ sourceId: id });
    } finally {
      closeHippoDb(db);
    }
  });

  it('supersede chains old -> new and audits with the supplied actor', () => {
    const { id: oldId } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'original-belief' },
    );

    const result = supersede(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_supersede' },
      oldId,
      'updated-belief',
    );
    expect(result.ok).toBe(true);
    expect(result.oldId).toBe(oldId);
    expect(result.newId).toMatch(/^mem_/);
    expect(result.newId).not.toBe(oldId);

    const oldEntry = readEntry(home, oldId);
    const newEntry = readEntry(home, result.newId);
    expect(oldEntry?.superseded_by).toBe(result.newId);
    expect(newEntry?.content).toBe('updated-belief');

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'supersede' });
      expect(events[0]!.actor).toBe('api_key:hk_supersede');
      expect(events[0]!.targetId).toBe(oldId);
      expect(events[0]!.metadata).toMatchObject({ newId: result.newId });
    } finally {
      closeHippoDb(db);
    }
  });
});
