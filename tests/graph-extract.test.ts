/**
 * E3.1 deterministic entity extraction - tests.
 * Docs: docs/plans/2026-06-01-e3-deterministic-extraction.md
 *
 * extractGraph rebuilds the graph from the consolidated E2 objects (decision/policy/
 * customer_note/project_brief -> entities + supersedes relations). Real DB, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry } from '../src/store.js';
import { saveDecision, closeDecision } from '../src/decisions.js';
import { savePolicy } from '../src/policies.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { saveProjectBrief } from '../src/project-briefs.js';
import { loadEntities, loadRelations } from '../src/graph.js';
import { extractGraph } from '../src/graph-extract.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graph-extract-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function entityCount(home: string): number {
  const db = openHippoDb(home);
  try { return (db.prepare(`SELECT COUNT(*) c FROM entities`).get() as { c: number }).c; }
  finally { closeHippoDb(db); }
}

describe('graph extraction (E3.1 deterministic, from consolidated E2 objects)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('extracts entities (4 types) + a supersedes relation; excludes closed; idempotent', () => {
    // decision v1 -> superseded by v2 (active)
    const d1 = saveDecision(home, 'default', { decisionText: 'Adopt Postgres' });
    const d2 = saveDecision(home, 'default', { decisionText: 'Adopt Postgres (managed)', supersedesDecisionId: d1.id });
    // a closed decision (must be excluded)
    const dc = saveDecision(home, 'default', { decisionText: 'Retired idea' });
    closeDecision(home, 'default', dc.id);
    // one of each other type
    savePolicy(home, 'default', { policyName: 'Data retention', policyText: 'Delete logs after 90 days' });
    saveCustomerNote(home, 'default', { customer: 'Acme Corp', note: 'renewal in Q3' });
    saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'agent-memory lib' });

    const r = extractGraph(home, 'default');
    expect(r.byType).toEqual({ decision: 2, policy: 1, customer: 1, project: 1 }); // dc excluded
    expect(r.entities).toBe(5);
    expect(r.relations).toBe(1);
    expect(r.truncated).toEqual([]);

    const ents = loadEntities(home, 'default', { limit: 100 });
    expect(ents.length).toBe(5);
    expect(ents.filter((e) => e.entityType === 'decision').length).toBe(2);
    expect(ents.some((e) => e.entityType === 'policy' && e.name === 'Data retention')).toBe(true);
    expect(ents.some((e) => e.entityType === 'customer' && e.name === 'Acme Corp')).toBe(true);
    expect(ents.some((e) => e.entityType === 'project' && e.name === 'hippo')).toBe(true);
    expect(ents.some((e) => e.name === 'Retired idea')).toBe(false); // closed excluded

    // the supersedes relation: v2 supersedes v1
    const e1 = ents.find((e) => e.name === 'Adopt Postgres')!;
    const e2 = ents.find((e) => e.name === 'Adopt Postgres (managed)')!;
    const rels = loadRelations(home, 'default', { limit: 100 });
    expect(rels.length).toBe(1);
    expect(rels[0].relType).toBe('supersedes');
    expect(rels[0].fromEntityId).toBe(e2.id); // successor
    expect(rels[0].toEntityId).toBe(e1.id);   // superseded

    // idempotent: re-running rebuilds to the same graph (no duplication)
    const r2 = extractGraph(home, 'default');
    expect(r2.entities).toBe(5);
    expect(r2.relations).toBe(1);
    expect(loadEntities(home, 'default', { limit: 100 }).length).toBe(5);
    expect(loadRelations(home, 'default', { limit: 100 }).length).toBe(1);
  });

  it('skips an E2 object whose source memory was forgotten (NULL memory_id)', () => {
    const dn = saveDecision(home, 'default', { decisionText: 'Will lose its memory' });
    deleteEntry(home, dn.memoryId!); // distilled delete is allowed; decisions.memory_id -> NULL
    saveDecision(home, 'default', { decisionText: 'Keeps its memory' });
    const r = extractGraph(home, 'default');
    expect(r.byType.decision).toBe(1); // only the one with a live memory
    const names = loadEntities(home, 'default', { limit: 100 }).map((e) => e.name);
    expect(names).toContain('Keeps its memory');
    expect(names).not.toContain('Will lose its memory');
  });

  it('skips a supersedes relation when the successor is not extracted (closed)', () => {
    // d1 superseded by d2, then d2 closed -> d1 superseded (extracted), d2 closed (not)
    const d1 = saveDecision(home, 'default', { decisionText: 'orig' });
    const d2 = saveDecision(home, 'default', { decisionText: 'replacement', supersedesDecisionId: d1.id });
    closeDecision(home, 'default', d2.id);
    const r = extractGraph(home, 'default');
    // d1 (superseded) extracted; d2 (closed) excluded -> no relation (successor missing)
    expect(r.byType.decision).toBe(1);
    expect(r.relations).toBe(0);
  });

  it('rebuild reflects current state: a brand-new object appears, a closed one disappears, on re-extract', () => {
    const d = saveDecision(home, 'default', { decisionText: 'first' });
    extractGraph(home, 'default');
    expect(entityCount(home)).toBe(1);
    saveDecision(home, 'default', { decisionText: 'second' });
    closeDecision(home, 'default', d.id);
    const r = extractGraph(home, 'default');
    expect(r.byType.decision).toBe(1); // 'second' present, 'first' (now closed) gone
    expect(loadEntities(home, 'default', { limit: 100 }).map((e) => e.name)).toEqual(['second']);
  });

  it('truncates an over-cap E2 name instead of throwing + bricking the rebuild (codex/independent-review)', () => {
    // decisionText is uncapped at source; a >512-char one must NOT throw in insertEntity
    // (which would leave the cleared graph empty + unrebuildable). It is truncated.
    const longText = 'D' + 'x'.repeat(700);
    saveDecision(home, 'default', { decisionText: longText });
    saveDecision(home, 'default', { decisionText: 'short one' });
    const r = extractGraph(home, 'default'); // must not throw
    expect(r.byType.decision).toBe(2);
    const ents = loadEntities(home, 'default', { limit: 100 });
    const longEnt = ents.find((e) => e.name.startsWith('Dxxx'))!;
    expect(longEnt).toBeDefined();
    expect(longEnt.name.length).toBeLessThanOrEqual(512);
    // re-run still works (not bricked)
    expect(() => extractGraph(home, 'default')).not.toThrow();
    expect(loadEntities(home, 'default', { limit: 100 }).length).toBe(2);
  });

  it('trims leading whitespace before capping (codex R2: a long whitespace-prefix name must not brick)', () => {
    const d = saveDecision(home, 'default', { decisionText: 'placeholder' });
    // Inject a name whose first 512 chars are whitespace (slice-without-trim would
    // yield a whitespace-only label -> insertEntity trims to '' -> throws -> brick).
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE decisions SET decision_text = ? WHERE id = ?`).run(' '.repeat(600) + 'real decision', d.id);
    } finally { closeHippoDb(db); }
    const r = extractGraph(home, 'default'); // must not throw
    expect(r.byType.decision).toBe(1);
    const ent = loadEntities(home, 'default', { limit: 100 })[0];
    expect(ent.name).toBe('real decision'); // trimmed, non-empty
    expect(() => extractGraph(home, 'default')).not.toThrow(); // not bricked
  });

  it('empty store extracts to an empty graph (no crash)', () => {
    const r = extractGraph(home, 'default');
    expect(r).toEqual({ entities: 0, relations: 0, references: 0, byType: { decision: 0, policy: 0, customer: 0, project: 0 }, truncated: [] });
  });
});
