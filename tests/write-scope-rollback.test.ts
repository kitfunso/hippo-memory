// A failure in the middle of a write scope leaves nothing behind. Real SQLite; a trigger makes the second write refuse.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { createPhysicsTable, savePhysicsState } from '../src/db/physics-state.js';
import { pruneAuditLog } from '../src/api/audit.js';
import { adminActor } from '../src/api/types.js';
import { writeRecallTrace } from '../src/store/recall-trace.js';
import { saveIndex } from '../src/store/index-and-stats.js';
import { closePrediction, savePrediction } from '../src/store/predictions.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { recordRereads, recordTokenUse } from '../src/store/token-ledger.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;

beforeEach(() => { root = makeRoot('write-scope'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function run(sql: string): void {
  const db = openHippoDb(root);
  try { db.exec(sql); } finally { closeHippoDb(db); }
}

function count(sql: string): number {
  const db = openHippoDb(root);
  try { return Number(db.prepare(sql).get<{ n: number | bigint }>()?.n ?? -1); } finally { closeHippoDb(db); }
}

function refuse(table: string, when: string): void {
  run(`CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refused'); END`);
}

describe('a write scope that fails in the middle rolls back', () => {
  it('saveIndex keeps neither meta key when the second one is refused', () => {
    const before = count("SELECT COUNT(*) AS n FROM meta WHERE value LIKE '%marker%'");
    run("CREATE TRIGGER refuse_meta BEFORE UPDATE ON meta WHEN NEW.key = 'last_trace_id' BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => saveIndex(root, { last_retrieval_ids: ['marker'], last_trace_id: 't' })).toThrow('refused');
    expect(count("SELECT COUNT(*) AS n FROM meta WHERE value LIKE '%marker%'")).toBe(before);
  });

  it('savePhysicsState keeps no particle when the second one is refused', () => {
    const a = createMemory('first particle', {});
    const b = createMemory('second particle', {});
    writeEntry(root, a);
    writeEntry(root, b);
    const db = openHippoDb(root);
    try {
      createPhysicsTable(db);
      db.exec(`CREATE TRIGGER refuse_second BEFORE INSERT ON memory_physics WHEN NEW.memory_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
      const particle = (memoryId: string) => ({ memoryId, position: [0.5], velocity: [0], mass: 1, charge: 0, temperature: 1, lastSimulation: new Date().toISOString() });
      expect(() => savePhysicsState(db, [particle(a.id), particle(b.id)])).toThrow('refused');
      expect(db.prepare('SELECT COUNT(*) AS n FROM memory_physics').get<{ n: number }>()?.n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('pruneAuditLog keeps the old rows when the prune record is refused', () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    run(`INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES ('${old}', 'default', 't', 'recall', NULL, '{}')`);
    refuse('audit_log', "NEW.op = 'audit_prune'");
    expect(() => pruneAuditLog({ hippoRoot: root, tenantId: 'default', actor: adminActor('cli') }, { olderThanDays: 30 })).toThrow('refused');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE op = 'recall'`)).toBe(1);
  });

  it('saveActiveTaskSnapshot keeps the old snapshot active when the new one is refused', () => {
    saveActiveTaskSnapshot(root, 'default', { task: 'first', summary: 's', next_step: 'n', session_id: 'x', source: 'test' });
    refuse('task_snapshots', "NEW.task = 'second'");
    expect(() => saveActiveTaskSnapshot(root, 'default', { task: 'second', summary: 's', next_step: 'n', session_id: 'x', source: 'test' })).toThrow('refused');
    expect(count(`SELECT COUNT(*) AS n FROM task_snapshots WHERE status = 'active' AND task = 'first'`)).toBe(1);
  });

  it('closePrediction leaves the prediction open when its audit row is refused', () => {
    const pred = savePrediction(root, 'default', { classTag: 'c', claimText: 'takes 2 days', estimateValue: 2, estimateUnit: 'days', targetDate: '2026-06-15' });
    refuse('audit_log', "NEW.op = 'predict_close'");
    expect(() => closePrediction(root, 'default', pred.id, { closureState: 'closed', actualValue: 3 })).toThrow('refused');
    expect(count(`SELECT COUNT(*) AS n FROM predictions WHERE closure_state = 'open'`)).toBe(1);
  });

  it('recordRereads keeps the old re-read rows when the new ones are refused', () => {
    const db = openHippoDb(root);
    try {
      const base = { tenantId: 'default', sessionId: 's1', items: 1, tokens: 10 };
      recordTokenUse(db, { ...base, surface: 'hook', event: 'inject' });
      recordTokenUse(db, { ...base, surface: 'hook', event: 'reread' });
    } finally {
      closeHippoDb(db);
    }
    refuse('token_ledger', "NEW.event = 'reread'");
    expect(() => recordRereads(root, 'default', 's1', [])).toThrow('refused');
    expect(count(`SELECT COUNT(*) AS n FROM token_ledger WHERE event = 'reread'`)).toBe(1);
  });

  it('writeRecallTrace stores no trace row when a result row is refused', () => {
    refuse('recall_trace_results', '1');
    const db = openHippoDb(root);
    try {
      const id = writeRecallTrace(db, { tenantId: 'default', pipeline: 'cli', query: 'q', results: [{ memoryId: 'm1', score: 1 }] });
      expect(id).toBeNull();
    } finally {
      closeHippoDb(db);
    }
    expect(count('SELECT COUNT(*) AS n FROM recall_traces')).toBe(0);
  });
});
