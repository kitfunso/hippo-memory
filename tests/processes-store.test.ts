/**
 * E2 process first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-29-e2-process-object.md
 *
 * Covers what only processes have; the shared lifecycle rules run per kind in typed-object-store.test.ts.
 * 1. saveProcess creates the memory mirror + processes row (+ process_create audit), version 1
 * 2. memory content: name + numbered steps + description
 * 3. loadProcesses status filter; loadActiveProcesses excludes non-active
 * 4. steps validation: non-array / non-string / empty / count cap / length cap; trim-then-store
 * 5. a damaged steps column reads as no steps and warns once per shape
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import {
  saveProcess,
  closeProcess,
  loadProcessById,
  loadProcesses,
  loadActiveProcesses,
  validateProcessSteps,
  MAX_PROCESS_STEPS,
  MAX_PROCESS_STEP_LEN,
} from '../src/objects/processes.js';
import { makeRoot } from './_helpers/make-root.js';
import { resetLogOnce } from '../src/util/log.js';
import { objectsAt } from './_helpers/objects-at.js';
import { loadConfig } from '../src/core/config.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: `SELECT COUNT(*) as c` always returns exactly one row shaped { c: number }.
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally { closeHippoDb(db); }
}

describe('processes store (first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('processes'); });
  afterEach(() => safeRmSync(home));

  it('saveProcess creates both memory and processes row + process_create audit, version 1', async () => {
    const proc = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
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
      // SAFETY: proc.memoryId is the id just returned by saveProcess's memory
      // mirror write; the row may not exist only if that write failed, which
      // the toBeDefined() assertion below checks before any further access.
      const memRow = db.prepare(`SELECT content, tags_json, source FROM memories WHERE id = ?`)
        .get(proc.memoryId!) as { content: string; tags_json: string; source: string } | undefined;
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('Release');
      expect(memRow!.content).toContain('1. run tests');
      expect(memRow!.content).toContain('Description: the npm release ritual');
      expect(memRow!.source).toBe('process');
      // SAFETY: tags_json is always written as a JSON array of strings (see
      // src/store/entry-writes.ts writeEntry serialization); never any other JSON shape.
      expect((JSON.parse(memRow!.tags_json) as string[])).toContain('process');

      // SAFETY: metadata_json for a process_create audit row is always a JSON
      // object with these fields (see src/objects/processes.ts saveProcess audit write).
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'process_create' AND target_id = ?`)
        .all(String(proc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      // SAFETY: metadata_json for a process_create audit row always includes
      // these fields, written by saveProcess (see src/objects/processes.ts).
      const meta = JSON.parse(rows[0].metadata_json) as { version: number; step_count: number; has_description: boolean };
      expect(meta.version).toBe(1);
      expect(meta.step_count).toBe(3);
      expect(meta.has_description).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveProcess without steps/description: bare name content', async () => {
    const proc = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'Empty', steps: [] });
    expect(proc.steps).toEqual([]);
    expect(proc.description).toBeNull();
    const db = openHippoDb(home);
    try {
      // SAFETY: proc.memoryId is the id just returned by saveProcess's memory
      // mirror write, so the row exists with a content column.
      const memRow = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(proc.memoryId!) as { content: string };
      expect(memRow.content).toBe('Empty');
    } finally { closeHippoDb(db); }
  });

  it('loadProcesses status filter; loadActiveProcesses excludes non-active', async () => {
    const a = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'active-1', steps: ['a'] });
    const b = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'to-supersede', steps: ['b'] });
    const c = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'to-close', steps: ['c'] });
    await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'to-supersede', steps: ['b', 'b2'], supersedesProcessId: b.id });
    await closeProcess(objectsAt(home), 'default', c.id);

    const active = await loadActiveProcesses(objectsAt(home), 'default');
    expect(active.every((x) => x.status === 'active')).toBe(true);
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(active.some((x) => x.id === c.id)).toBe(false);

    expect((await loadProcesses(objectsAt(home), 'default', { status: 'superseded' })).map((x) => x.id)).toEqual([b.id]);
    expect((await loadProcesses(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([c.id]);
    // a (active), b (superseded), c (closed), b-v2 (active) = 4 total rows.
    expect((await loadProcesses(objectsAt(home), 'default')).length).toBe(4);
  });

  it('steps validation: rejects non-array / non-string / empty / cap breaches; trims-then-stores', async () => {
    expect(() => validateProcessSteps('not an array')).toThrow(/must be an array/);
    expect(() => validateProcessSteps([1, 2])).toThrow(/not a string/);
    expect(() => validateProcessSteps(['ok', '   '])).toThrow(/is empty/);
    expect(() => validateProcessSteps(Array(MAX_PROCESS_STEPS + 1).fill('x'))).toThrow(/step cap/);
    expect(() => validateProcessSteps(['y'.repeat(MAX_PROCESS_STEP_LEN + 1)])).toThrow(/char cap/);
    // trim-then-store: a padded step is stored trimmed.
    expect(validateProcessSteps(['  spaced  '])).toEqual(['spaced']);

    const proc = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'Trim', steps: ['  lead/trail  '] });
    expect(proc.steps).toEqual(['lead/trail']);
    expect((await loadProcessById(objectsAt(home), 'default', proc.id))!.steps).toEqual(['lead/trail']);
    // saveProcess rejects bad steps and writes nothing.
    const before = countRows(home, 'processes');
    await expect(saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'Bad', steps: ['', 'x'] })).rejects.toThrow(/is empty/);
    expect(countRows(home, 'processes')).toBe(before);
  });

  it('a damaged steps column reads as no steps and warns once per shape', async () => {
    const proc = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'Damaged', steps: ['a'] });
    const other = await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { processName: 'WrongShape', steps: ['a'] });
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE processes SET steps = '[private-step' WHERE id = ?`).run(proc.id);
      db.prepare(`UPDATE processes SET steps = '{"a":1}' WHERE id = ?`).run(other.id);
    } finally { closeHippoDb(db); }

    resetLogOnce();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let logged: string;
    try {
      expect((await loadProcessById(objectsAt(home), 'default', proc.id))!.steps).toEqual([]);
      expect((await loadProcessById(objectsAt(home), 'default', other.id))!.steps).toEqual([]);
      logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
    }
    expect(logged).toMatch(new RegExp(`processes\\.steps is not valid JSON.* id=${proc.id} column=steps`));
    expect(logged).toMatch(new RegExp(`processes\\.steps is wrong shape.* id=${other.id} column=steps`));
    expect(logged).not.toContain('private-');
  });
});
