/** Sleep in a store shared by projects (the global store) never blends, dedups or conflicts two projects' memories. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { detectConflicts } from '../src/consolidate/conflicts.js';
import { deduplicateStore } from '../src/dedupe.js';
import { buildDag, buildEntityProfiles } from '../src/dag.js';
import { storeExtractedFacts } from '../src/extract.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-sleep-origin-'));
  initStore(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const fetcher = (text: string) => vi.fn<typeof fetch>(async () => new Response(
  JSON.stringify({ content: [{ text }] }), { status: 200, headers: { 'content-type': 'application/json' } },
));
const inProject = (entry: MemoryEntry, origin: string | null): MemoryEntry => ({ ...entry, origin_project: origin });
const live = () => loadAllEntries(home).filter((e) => !e.superseded_by);

describe('sleep partitions by origin project', () => {
  it('the merge pass merges within a project only, and the merged row stays in that project', async () => {
    const backbone = 'rotate the staging tls certificates before expiry';
    for (const [origin, marker] of [['proj-b', 'bravomarker'], ['proj-c', 'charliemarker']] as const) {
      writeEntry(home, inProject(createMemory(backbone, { layer: Layer.Episodic }), origin));
      writeEntry(home, inProject(createMemory(`${backbone} ${marker} notify the on-call channel`, { layer: Layer.Episodic }), origin));
    }

    expect((await consolidate(home, { dryRun: false })).semanticCreated).toBe(2);

    const merged = live().filter((e) => e.source === 'consolidation');
    expect(merged.map((e) => e.origin_project).sort()).toEqual(['proj-b', 'proj-c']);
    expect(merged.find((e) => e.origin_project === 'proj-b')!.content).not.toContain('charliemarker');
    expect(merged.find((e) => e.origin_project === 'proj-c')!.content).not.toContain('bravomarker');
  });

  it('a merge of rows with no known project stays unknown, never user-global', async () => {
    const backbone = 'rotate the staging tls certificates before expiry';
    writeEntry(home, inProject(createMemory(backbone, { layer: Layer.Episodic }), null));
    writeEntry(home, inProject(createMemory(`${backbone} notify the on-call channel`, { layer: Layer.Episodic }), null));

    await consolidate(home, { dryRun: false });

    expect(live().filter((e) => e.source === 'consolidation').map((e) => e.origin_project)).toEqual([null]);
  });

  it('dedup keeps one copy per project and still removes a copy within one project', () => {
    const text = 'the staging database password lives in the team vault under ops';
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-b'));
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-c'));
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-c'));

    expect(deduplicateStore(home).removed).toBe(1);
    expect(live().map((e) => e.origin_project).sort()).toEqual(['proj-b', 'proj-c']);
  });

  it('two projects may hold opposite rules, but a user-global rule still conflicts with a project rule', () => {
    const now = new Date();
    const rule = (text: string, origin: string, id: string): MemoryEntry => ({
      ...inProject(createMemory(text, {}), origin), id, created: now.toISOString(), last_retrieved: now.toISOString(),
    });
    const always = rule('always alpha beta gamma', 'proj-b', 'b');
    const never = rule('never alpha beta gamma zeta', 'proj-c', 'c');
    expect(detectConflicts([always, never], now)).toEqual([]);
    expect(detectConflicts([always, { ...never, origin_project: '' }], now)).toHaveLength(1);
    expect(detectConflicts([always, { ...never, origin_project: 'proj-b', tenantId: 'other' }], now)).toEqual([]);
  });

  it('facts extracted from a project row stay in that project; from an unknown row they stay unknown', () => {
    for (const origin of ['proj-b', null]) {
      const source = inProject(createMemory(`alice prefers dark mode in ${origin}`, { layer: Layer.Episodic }), origin);
      writeEntry(home, source);
      const [fact] = storeExtractedFacts(home, source, [{ content: `alice prefers dark mode (${origin})`, tags: [], valence: 'neutral' }]);
      expect(live().find((e) => e.id === fact!.id)!.origin_project).toBe(origin);
    }
  });

  it('the DAG summarises facts and summaries within a project, and each summary stays in that project', async () => {
    const facts = ['proj-b', 'proj-c'].flatMap((origin) => ['alice filed X', 'alice noted Y', 'alice closed Z'].map((c) =>
      inProject(createMemory(`${c} in ${origin}`, { layer: Layer.Episodic, dag_level: 1, tags: ['extracted', 'speaker:alice'] }), origin)));
    for (const f of facts) writeEntry(home, f);

    expect((await buildDag(home, facts, { apiKey: 'k', fetcher: fetcher('alice files, notes and closes tickets') })).summariesCreated).toBe(2);
    const l2s = live().filter((e) => e.dag_level === 2);
    expect(l2s.map((e) => e.origin_project).sort()).toEqual(['proj-b', 'proj-c']);

    const more = ['proj-b', 'proj-c'].map((origin) => inProject(createMemory(`alice owns the API layer in ${origin}`, {
      layer: Layer.Semantic, tags: ['speaker:alice', 'dag-summary'], confidence: 'inferred', dag_level: 2,
    }), origin));
    for (const l2 of more) writeEntry(home, l2);

    expect((await buildEntityProfiles(home, [...l2s, ...more], { apiKey: 'k', fetcher: fetcher('alice is the typed-python API owner') })).profilesCreated).toBe(2);
    expect(live().filter((e) => e.dag_level === 3).map((e) => e.origin_project).sort()).toEqual(['proj-b', 'proj-c']);
  });
});

describe('conflicts never pair across a personal scope', () => {
  const now = new Date();
  const rule = (text: string, id: string, scope: string | null): MemoryEntry => ({
    ...createMemory(text, { scope }), id, origin_project: 'proj', created: now.toISOString(), last_retrieved: now.toISOString(),
  });
  const ALICE = 'personal:private:alice';

  it('a personal row against a team row gives no pair, while two team rows do', () => {
    const always = rule('always alpha beta gamma', 'a', null);
    const never = rule('never alpha beta gamma zeta', 'b', null);
    expect(detectConflicts([always, never], now)).toHaveLength(1);
    expect(detectConflicts([{ ...always, scope: ALICE }, never], now)).toEqual([]);
    expect(detectConflicts([always, { ...never, scope: ALICE }], now)).toEqual([]);
  });

  it('two rows in one personal scope still pair', () => {
    const pair = detectConflicts([rule('always alpha beta gamma', 'a', ALICE), rule('never alpha beta gamma zeta', 'b', ALICE)], now);
    expect(pair.map((p) => [p.memory_a_id, p.memory_b_id])).toEqual([['a', 'b']]);
  });

  it('two owners, or a case variant of one owner, never pair', () => {
    const mine = rule('always alpha beta gamma', 'a', ALICE);
    expect(detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'personal:private:bob')], now)).toEqual([]);
    expect(detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'Personal:private:alice')], now)).toEqual([]);
  });
});
