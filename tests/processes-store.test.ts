/**
 * E2 process first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-29-e2-process-object.md
 *
 * Covers:
 * 1. saveProcess creates the memory mirror + processes row (+ process_create audit), version 1
 * 2. memory content: name + numbered steps + description
 * 3. SAVEPOINT atomicity: writeEntry afterWrite throw rolls back BOTH
 * 4. supersede flips predecessor -> superseded, new row v2, change_summary set, process_supersede audit
 * 5. version chain v1 -> v2 -> v3 (server-derived)
 * 6. supersede CAS: re-superseding a superseded row throws not-active; missing id throws not-found
 * 7. self-supersede preflight guard: supersede on an empty store throws not-found, creates nothing
 * 8. closeProcess flips active -> closed (+ process_close audit)
 * 9. close guard: not-found; cannot close a superseded row; cannot re-close
 * 10. cross-tenant INSERT trigger raises ABORT (memory tenant mismatch)
 * 11. supersede tenant-match trigger raises ABORT on cross-tenant superseded_by
 * 12. ON DELETE SET NULL: forget the memory, process + old version survive (loadable)
 * 13. loadProcesses status filter; loadActiveProcesses excludes non-active
 * 14. loadProcesses rejects an invalid status
 * 15. steps validation: non-array / non-string / empty / count cap / length cap; trim-then-store
 * 16. tenant scoping: cross-tenant load returns empty
 * 17. schema v32 produces processes table + 3 triggers + 2 indexes
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
  saveProcess,
  closeProcess,
  loadProcessById,
  loadProcesses,
  loadActiveProcesses,
  validateProcessSteps,
  VALID_PROCESS_STATES,
  MAX_PROCESS_STEPS,
  MAX_PROCESS_STEP_LEN,
} from '../src/processes.js';

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

describe('processes store (E2 first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('processes'); });
  afterEach(() => safeRmSync(home));

  it('saveProcess creates both memory and processes row + process_create audit, version 1', () => {
    const proc = saveProcess(home, 'default', {
      processName: 'Release',
      steps: ['run tests', 'bump version', 'publish'],
      description: 'the npm release ritual',
    });
    expect(proc.id).toBeGreaterThan(0);
    expect(proc.memoryId).not.toBeNull();
    expect(proc.tenantId).toBe('default');
    expect(proc.processName).toBe('Release');
    expect(proc.steps).toEqual(['run tests', 'bump version', 'publish']);
    expect(proc.version).toBe(1);
    expect(proc.status).toBe('active');
    expect(proc.supersededBy).toBeNull();
    expect(proc.changeSummary).toBeNull();
    expect(proc.closedAt).toBeNull();

    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, tags_json, source FROM memories WHERE id = ?`)
        .get(proc.memoryId!) as { content: string; tags_json: string; source: string } | undefined;
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('Release');
      expect(memRow!.content).toContain('1. run tests');
      expect(memRow!.content).toContain('Description: the npm release ritual');
      expect(memRow!.source).toBe('process');
      expect((JSON.parse(memRow!.tags_json) as string[])).toContain('process');

      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'process_create' AND target_id = ?`)
        .all(String(proc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { version: number; step_count: number; has_description: boolean };
      expect(meta.version).toBe(1);
      expect(meta.step_count).toBe(3);
      expect(meta.has_description).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveProcess without steps/description: bare name content', () => {
    const proc = saveProcess(home, 'default', { processName: 'Empty', steps: [] });
    expect(proc.steps).toEqual([]);
    expect(proc.description).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(proc.memoryId!) as { content: string };
      expect(memRow.content).toBe('Empty');
    } finally { closeHippoDb(db); }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both memory and processes row', () => {
    const memBefore = countRows(home, 'memories');
    const procBefore = countRows(home, 'processes');
    const mem = createMemory('throwing process', {
      tags: ['process'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'process',
      tenantId: 'default',
    });
    expect(() => {
      writeEntry(home, mem, {
        afterWrite: () => { throw new Error('forced afterWrite failure'); },
      });
    }).toThrow('forced afterWrite failure');
    expect(countRows(home, 'memories')).toBe(memBefore);
    expect(countRows(home, 'processes')).toBe(procBefore);
  });

  it('supersede: predecessor -> superseded, new row v2 with change_summary + process_supersede audit', () => {
    const v1 = saveProcess(home, 'default', { processName: 'Deploy', steps: ['a', 'b'] });
    const v2 = saveProcess(home, 'default', {
      processName: 'Deploy',
      steps: ['a', 'b', 'c'],
      changeSummary: 'added a rollback step',
      supersedesProcessId: v1.id,
    });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('active');
    expect(v2.changeSummary).toBe('added a rollback step');
    expect(v2.steps).toEqual(['a', 'b', 'c']);

    const reloadedV1 = loadProcessById(home, 'default', v1.id)!;
    expect(reloadedV1.status).toBe('superseded');
    expect(reloadedV1.supersededBy).toBe(v2.id);
    expect(reloadedV1.supersededAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'process_supersede' AND target_id = ?`)
        .all(String(v1.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { superseded_by: number; new_version: number };
      expect(meta.superseded_by).toBe(v2.id);
      expect(meta.new_version).toBe(2);
    } finally { closeHippoDb(db); }
  });

  it('version chain v1 -> v2 -> v3 is server-derived', () => {
    const v1 = saveProcess(home, 'default', { processName: 'Chain', steps: ['x'] });
    const v2 = saveProcess(home, 'default', { processName: 'Chain', steps: ['x', 'y'], supersedesProcessId: v1.id });
    const v3 = saveProcess(home, 'default', { processName: 'Chain', steps: ['x', 'y', 'z'], supersedesProcessId: v2.id });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(loadActiveProcesses(home, 'default').map((p) => p.id)).toEqual([v3.id]);
  });

  it('supersede CAS: re-superseding a superseded row throws not-active; missing id throws not-found', () => {
    const v1 = saveProcess(home, 'default', { processName: 'Once', steps: ['a'] });
    saveProcess(home, 'default', { processName: 'Once', steps: ['a', 'b'], supersedesProcessId: v1.id });
    // v1 is now superseded; superseding it again must fail.
    expect(() => saveProcess(home, 'default', {
      processName: 'Once', steps: ['c'], supersedesProcessId: v1.id,
    })).toThrow(/not active/);
    expect(() => saveProcess(home, 'default', {
      processName: 'Ghost', steps: ['c'], supersedesProcessId: 99999,
    })).toThrow(/not found/);
  });

  it('self-supersede preflight guard: supersede on an empty store throws not-found, creates nothing', () => {
    const memBefore = countRows(home, 'memories');
    const procBefore = countRows(home, 'processes');
    // No process id 1 exists yet: the preflight must reject BEFORE the INSERT
    // so a new row can never become its own supersede target.
    expect(() => saveProcess(home, 'default', {
      processName: 'SelfRef', steps: ['a'], supersedesProcessId: 1,
    })).toThrow(/not found/);
    expect(countRows(home, 'processes')).toBe(procBefore);
    expect(countRows(home, 'memories')).toBe(memBefore);
  });

  it('closeProcess flips active -> closed + emits process_close audit', () => {
    const proc = saveProcess(home, 'default', { processName: 'Retire', steps: ['a'] });
    const closed = closeProcess(home, 'default', proc.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'process_close' AND target_id = ?`)
        .all(String(proc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('close guard: not-found; cannot close a superseded row; cannot re-close', () => {
    expect(() => closeProcess(home, 'default', 77777)).toThrow(/not found/);

    const v1 = saveProcess(home, 'default', { processName: 'Sup', steps: ['a'] });
    saveProcess(home, 'default', { processName: 'Sup', steps: ['a', 'b'], supersedesProcessId: v1.id });
    // v1 is superseded (terminal in the chain) — closing it is not allowed.
    expect(() => closeProcess(home, 'default', v1.id)).toThrow(/not active/);

    const c = saveProcess(home, 'default', { processName: 'Close', steps: ['a'] });
    closeProcess(home, 'default', c.id);
    expect(() => closeProcess(home, 'default', c.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger raises ABORT on memory tenant mismatch', () => {
    const mem = createMemory('tenant-a memory', {
      tags: ['process'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'process',
      tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`
          INSERT INTO processes(memory_id, tenant_id, process_name, steps, version, status, created_at)
          VALUES (?, 'tenant-b', 'cross-tenant attempt', '[]', 1, 'active', ?)
        `).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
  });

  it('supersede tenant-match trigger raises ABORT on cross-tenant superseded_by', () => {
    const a = saveProcess(home, 'tenant-a', { processName: 'A', steps: ['a'] });
    const b = saveProcess(home, 'tenant-b', { processName: 'B', steps: ['b'] });
    const db = openHippoDb(home);
    try {
      // Pointing tenant-a's row at tenant-b's row as its successor must ABORT.
      expect(() => {
        db.prepare(`UPDATE processes SET superseded_by = ? WHERE id = ?`).run(b.id, a.id);
      }).toThrow(/superseded_by must reference a process in the same tenant/);
    } finally { closeHippoDb(db); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the process; old versions stay loadable', () => {
    const v1 = saveProcess(home, 'default', { processName: 'Durable', steps: ['a'] });
    const v2 = saveProcess(home, 'default', { processName: 'Durable', steps: ['a', 'b'], supersedesProcessId: v1.id });
    // Forget both versions' memory mirrors; the canonical rows must survive.
    deleteEntry(home, v1.memoryId!, 'default');
    deleteEntry(home, v2.memoryId!, 'default');
    const reV1 = loadProcessById(home, 'default', v1.id);
    const reV2 = loadProcessById(home, 'default', v2.id);
    expect(reV1).not.toBeNull();
    expect(reV1!.memoryId).toBeNull();
    expect(reV1!.status).toBe('superseded');
    expect(reV1!.supersededBy).toBe(v2.id);
    expect(reV2).not.toBeNull();
    expect(reV2!.memoryId).toBeNull();
    expect(reV2!.status).toBe('active');
  });

  it('loadProcesses status filter; loadActiveProcesses excludes non-active', () => {
    const a = saveProcess(home, 'default', { processName: 'active-1', steps: ['a'] });
    const b = saveProcess(home, 'default', { processName: 'to-supersede', steps: ['b'] });
    const c = saveProcess(home, 'default', { processName: 'to-close', steps: ['c'] });
    saveProcess(home, 'default', { processName: 'to-supersede', steps: ['b', 'b2'], supersedesProcessId: b.id });
    closeProcess(home, 'default', c.id);

    const active = loadActiveProcesses(home, 'default');
    expect(active.every((x) => x.status === 'active')).toBe(true);
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);

    expect(loadProcesses(home, 'default', { status: 'superseded' }).map((x) => x.id)).toEqual([b.id]);
    expect(loadProcesses(home, 'default', { status: 'closed' }).map((x) => x.id)).toEqual([c.id]);
    // a (active), b (superseded), c (closed), b-v2 (active) = 4 total rows.
    expect(loadProcesses(home, 'default').length).toBe(4);
  });

  it('loadProcesses rejects an invalid status', () => {
    expect(() => {
      // @ts-expect-error — runtime validation test
      loadProcesses(home, 'default', { status: 'retired' });
    }).toThrow(/status must be one of/);
    expect(VALID_PROCESS_STATES.has('active')).toBe(true);
    expect(VALID_PROCESS_STATES.has('superseded')).toBe(true);
    expect(VALID_PROCESS_STATES.has('closed')).toBe(true);
  });

  it('steps validation: rejects non-array / non-string / empty / cap breaches; trims-then-stores', () => {
    // @ts-expect-error — runtime validation test
    expect(() => validateProcessSteps('not an array')).toThrow(/must be an array/);
    // @ts-expect-error — runtime validation test
    expect(() => validateProcessSteps([1, 2])).toThrow(/not a string/);
    expect(() => validateProcessSteps(['ok', '   '])).toThrow(/is empty/);
    expect(() => validateProcessSteps(Array(MAX_PROCESS_STEPS + 1).fill('x'))).toThrow(/step cap/);
    expect(() => validateProcessSteps(['y'.repeat(MAX_PROCESS_STEP_LEN + 1)])).toThrow(/char cap/);
    // trim-then-store: a padded step is stored trimmed.
    expect(validateProcessSteps(['  spaced  '])).toEqual(['spaced']);

    const proc = saveProcess(home, 'default', { processName: 'Trim', steps: ['  lead/trail  '] });
    expect(proc.steps).toEqual(['lead/trail']);
    expect(loadProcessById(home, 'default', proc.id)!.steps).toEqual(['lead/trail']);
    // saveProcess rejects bad steps and writes nothing.
    const before = countRows(home, 'processes');
    expect(() => saveProcess(home, 'default', { processName: 'Bad', steps: ['', 'x'] })).toThrow(/is empty/);
    expect(countRows(home, 'processes')).toBe(before);
  });

  it('tenant scoping: cross-tenant load returns empty', () => {
    saveProcess(home, 'tenant-a', { processName: 'a-proc', steps: ['a'] });
    saveProcess(home, 'tenant-b', { processName: 'b-proc', steps: ['b'] });
    expect(loadProcesses(home, 'tenant-a').length).toBe(1);
    expect(loadProcesses(home, 'tenant-b').length).toBe(1);
    expect(loadProcesses(home, 'tenant-c').length).toBe(0);
    const a = loadProcesses(home, 'tenant-a')[0];
    expect(loadProcessById(home, 'tenant-b', a.id)).toBeNull();
  });

  it('schema v32 produces processes table + 3 triggers + 2 indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='processes'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_processes_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_processes_tenant_match_insert');
      expect(triggers).toContain('trg_processes_tenant_match_update');
      expect(triggers).toContain('trg_processes_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_processes_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_processes_tenant_status');
      expect(indexes).toContain('idx_processes_memory');
    } finally { closeHippoDb(db); }
  });
});
