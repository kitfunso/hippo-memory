/**
 * E2 decision first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-28-e2-decision-object.md
 *
 * Covers:
 * 1. saveDecision creates both the memory mirror and the decisions row
 * 2. saveDecision without context: bare memory content, has_context false
 * 3. SAVEPOINT atomicity: writeEntry afterWrite throw rolls back BOTH
 * 4. saveDecision with supersedesDecisionId supersedes the old row atomically
 * 5. supersede CAS: re-superseding an already-superseded row throws, no orphan
 * 6. supersede of a non-existent decision throws not found
 * 7. closeDecision flips active -> closed + emits decision_close audit
 * 8. close guard: not-found vs not-active (already closed / superseded)
 * 9. cross-tenant INSERT trigger raises ABORT (memory tenant mismatch)
 * 10. superseded_by cross-tenant trigger raises ABORT
 * 11. ON DELETE SET NULL: forget the memory, decision survives (decay-bug proof)
 * 12. loadDecisions status filter; loadActiveDecisions excludes non-active
 * 13. loadDecisions rejects an invalid status
 * 14. resolveActiveDecisionIdByMemory (row id first-class, null legacy/superseded)
 * 15. tenant scoping: cross-tenant load returns empty
 * 16. schema v30 produces decisions table + triggers + indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  deleteEntry,
  writeEntry,
} from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  saveDecision,
  closeDecision,
  loadDecisionById,
  loadDecisions,
  loadActiveDecisions,
  resolveActiveDecisionIdByMemory,
  VALID_DECISION_STATES,
} from '../src/decisions.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally { closeHippoDb(db); }
}

describe('decisions store (E2 first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('decisions'); });
  afterEach(() => safeRmSync(home));

  it('saveDecision creates both memory and decisions row + decision_create audit', () => {
    const d = saveDecision(home, 'default', {
      decisionText: 'use Postgres',
      context: 'scale and JSONB',
    });
    expect(d.id).toBeGreaterThan(0);
    expect(d.memoryId).not.toBeNull();
    expect(d.tenantId).toBe('default');
    expect(d.decisionText).toBe('use Postgres');
    expect(d.context).toBe('scale and JSONB');
    expect(d.status).toBe('active');
    expect(d.supersededBy).toBeNull();
    expect(d.supersededAt).toBeNull();
    expect(d.closedAt).toBeNull();

    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, tags_json, source FROM memories WHERE id = ?`)
        .get(d.memoryId!) as { content: string; tags_json: string; source: string } | undefined;
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('use Postgres');
      expect(memRow!.content).toContain('Context: scale and JSONB');
      expect(memRow!.source).toBe('decision');
      expect((JSON.parse(memRow!.tags_json) as string[])).toContain('decision');

      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'decision_create' AND target_id = ?`)
        .all(String(d.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { decision_id: number; has_context: boolean };
      expect(meta.has_context).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveDecision without context: bare memory content, has_context false', () => {
    const d = saveDecision(home, 'default', { decisionText: 'adopt trunk-based dev' });
    expect(d.context).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(d.memoryId!) as { content: string };
      expect(memRow.content).toBe('adopt trunk-based dev');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'decision_create' AND target_id = ?`)
        .all(String(d.id)) as Array<{ metadata_json: string }>;
      expect((JSON.parse(rows[0].metadata_json) as { has_context: boolean }).has_context).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both memory and decisions row', () => {
    const memBefore = countRows(home, 'memories');
    const decBefore = countRows(home, 'decisions');

    const mem = createMemory('throwing decision', {
      tags: ['decision'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
      tenantId: 'default',
    });
    expect(() => {
      writeEntry(home, mem, {
        afterWrite: () => { throw new Error('forced afterWrite failure'); },
      });
    }).toThrow('forced afterWrite failure');

    expect(countRows(home, 'memories')).toBe(memBefore);
    expect(countRows(home, 'decisions')).toBe(decBefore);
  });

  it('saveDecision with supersedesDecisionId supersedes the old row atomically + emits decision_supersede', () => {
    const first = saveDecision(home, 'default', { decisionText: 'use REST' });
    const second = saveDecision(home, 'default', {
      decisionText: 'use GraphQL',
      supersedesDecisionId: first.id,
    });

    expect(second.status).toBe('active');
    const reloadedFirst = loadDecisionById(home, 'default', first.id);
    expect(reloadedFirst!.status).toBe('superseded');
    expect(reloadedFirst!.supersededBy).toBe(second.id);
    expect(reloadedFirst!.supersededAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'decision_supersede' AND target_id = ?`)
        .all(String(first.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { decision_id: number; superseded_by: number };
      expect(meta.superseded_by).toBe(second.id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('supersede CAS: re-superseding an already-superseded row throws and leaves no orphan', () => {
    const first = saveDecision(home, 'default', { decisionText: 'version one' });
    saveDecision(home, 'default', { decisionText: 'version two', supersedesDecisionId: first.id });

    const decBefore = countRows(home, 'decisions');
    const memBefore = countRows(home, 'memories');
    expect(() => {
      saveDecision(home, 'default', { decisionText: 'version three', supersedesDecisionId: first.id });
    }).toThrow(/not active/);
    // The failed v3 save rolled back: no new decisions row, no new memory.
    expect(countRows(home, 'decisions')).toBe(decBefore);
    expect(countRows(home, 'memories')).toBe(memBefore);
  });

  it('supersede of a non-existent decision throws not found', () => {
    expect(() => {
      saveDecision(home, 'default', { decisionText: 'placeholder decision text', supersedesDecisionId: 99999 });
    }).toThrow(/not found/);
  });

  it('preflight prevents self-supersession: superseding the soon-to-be id on an empty store throws not found, creates nothing (codex P1 regression)', () => {
    // Fresh store: the next autoincrement id is 1. Superseding id 1 as the very
    // first op must NOT self-match the row being inserted (which would set it
    // superseded_by itself). Preflight-before-insert => not found + full rollback.
    const decBefore = countRows(home, 'decisions');
    const memBefore = countRows(home, 'memories');
    expect(() => {
      saveDecision(home, 'default', { decisionText: 'first decision attempt', supersedesDecisionId: 1 });
    }).toThrow(/not found/);
    expect(countRows(home, 'decisions')).toBe(decBefore);
    expect(countRows(home, 'memories')).toBe(memBefore);
  });

  it('no decision can supersede itself (superseded_by never equals own id)', () => {
    const first = saveDecision(home, 'default', { decisionText: 'predecessor decision' });
    const second = saveDecision(home, 'default', { decisionText: 'successor decision', supersedesDecisionId: first.id });
    expect(second.id).not.toBe(first.id);
    expect(second.supersededBy).toBeNull();
    const reFirst = loadDecisionById(home, 'default', first.id);
    expect(reFirst!.supersededBy).toBe(second.id);
    expect(reFirst!.supersededBy).not.toBe(reFirst!.id);
  });

  it('closeDecision flips active -> closed + emits decision_close audit', () => {
    const d = saveDecision(home, 'default', { decisionText: 'use webpack' });
    const closed = closeDecision(home, 'default', d.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'decision_close' AND target_id = ?`)
        .all(String(d.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('close guard: not-found and not-active (already closed / superseded) error clearly', () => {
    expect(() => closeDecision(home, 'default', 88888)).toThrow(/not found/);

    const d = saveDecision(home, 'default', { decisionText: 'close twice' });
    closeDecision(home, 'default', d.id);
    expect(() => closeDecision(home, 'default', d.id)).toThrow(/not active/);

    const sup = saveDecision(home, 'default', { decisionText: 'orig' });
    saveDecision(home, 'default', { decisionText: 'next', supersedesDecisionId: sup.id });
    expect(() => closeDecision(home, 'default', sup.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger raises ABORT on memory tenant mismatch', () => {
    const mem = createMemory('tenant-a memory', {
      tags: ['decision'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
      tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`
          INSERT INTO decisions(memory_id, tenant_id, decision_text, status, created_at)
          VALUES (?, 'tenant-b', 'cross-tenant attempt', 'active', ?)
        `).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
  });

  it('superseded_by cross-tenant trigger raises ABORT', () => {
    const a = saveDecision(home, 'tenant-a', { decisionText: 'a-decision' });
    const b = saveDecision(home, 'tenant-b', { decisionText: 'b-decision' });
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`UPDATE decisions SET superseded_by = ? WHERE id = ?`).run(b.id, a.id);
      }).toThrow(/superseded_by must reference a decision in the same tenant/);
    } finally { closeHippoDb(db); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the decision (decay-bug structural proof)', () => {
    const d = saveDecision(home, 'default', { decisionText: 'survives memory decay' });
    expect(d.memoryId).not.toBeNull();
    deleteEntry(home, d.memoryId!, 'default');
    const reloaded = loadDecisionById(home, 'default', d.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.memoryId).toBeNull();
    expect(reloaded!.status).toBe('active');
    expect(reloaded!.decisionText).toBe('survives memory decay');
    // Still surfaces in the authoritative active list even with no memory.
    const active = loadActiveDecisions(home, 'default');
    expect(active.some((x) => x.id === d.id)).toBe(true);
  });

  it('loadDecisions status filter; loadActiveDecisions excludes non-active', () => {
    const a = saveDecision(home, 'default', { decisionText: 'active-1' });
    const b = saveDecision(home, 'default', { decisionText: 'to-close' });
    const c = saveDecision(home, 'default', { decisionText: 'to-supersede' });
    closeDecision(home, 'default', b.id);
    saveDecision(home, 'default', { decisionText: 'successor', supersedesDecisionId: c.id });

    const active = loadActiveDecisions(home, 'default');
    expect(active.every((x) => x.status === 'active')).toBe(true);
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);

    const closed = loadDecisions(home, 'default', { status: 'closed' });
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(b.id);

    const superseded = loadDecisions(home, 'default', { status: 'superseded' });
    expect(superseded.length).toBe(1);
    expect(superseded[0].id).toBe(c.id);

    const all = loadDecisions(home, 'default');
    expect(all.length).toBe(4);
  });

  it('loadDecisions rejects an invalid status', () => {
    expect(() => {
      // @ts-expect-error — runtime validation test
      loadDecisions(home, 'default', { status: 'retired' });
    }).toThrow(/status must be one of/);
    expect(VALID_DECISION_STATES.has('active')).toBe(true);
    expect(VALID_DECISION_STATES.has('superseded')).toBe(true);
    expect(VALID_DECISION_STATES.has('closed')).toBe(true);
  });

  it('resolveActiveDecisionIdByMemory: row id for first-class, null for legacy/superseded', () => {
    const d = saveDecision(home, 'default', { decisionText: 'first-class' });
    expect(resolveActiveDecisionIdByMemory(home, 'default', d.memoryId!)).toBe(d.id);

    // A legacy decision-tagged memory with NO decisions row
    const legacy = createMemory('legacy decision memory', {
      tags: ['decision'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'decision',
      tenantId: 'default',
    });
    writeEntry(home, legacy);
    expect(resolveActiveDecisionIdByMemory(home, 'default', legacy.id)).toBeNull();

    // A superseded decision's memory no longer resolves (status != active)
    const sup = saveDecision(home, 'default', { decisionText: 'old' });
    saveDecision(home, 'default', { decisionText: 'new', supersedesDecisionId: sup.id });
    expect(resolveActiveDecisionIdByMemory(home, 'default', sup.memoryId!)).toBeNull();
  });

  it('tenant scoping: cross-tenant load returns empty', () => {
    saveDecision(home, 'tenant-a', { decisionText: 'a-dec' });
    saveDecision(home, 'tenant-b', { decisionText: 'b-dec' });
    expect(loadDecisions(home, 'tenant-a').length).toBe(1);
    expect(loadDecisions(home, 'tenant-b').length).toBe(1);
    expect(loadDecisions(home, 'tenant-c').length).toBe(0);
    const a = loadDecisions(home, 'tenant-a')[0];
    expect(loadDecisionById(home, 'tenant-b', a.id)).toBeNull();
  });

  it('schema v30 produces decisions table + triggers + indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_decisions_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_decisions_tenant_match_insert');
      expect(triggers).toContain('trg_decisions_tenant_match_update');
      expect(triggers).toContain('trg_decisions_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_decisions_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_decisions_tenant_status');
      expect(indexes).toContain('idx_decisions_memory');
    } finally { closeHippoDb(db); }
  });
});
