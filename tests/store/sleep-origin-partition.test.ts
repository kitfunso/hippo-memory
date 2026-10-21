/** Sleep in a store shared by projects (the global store) never blends, dedups or conflicts two projects' memories. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { consolidate } from '../../src/index.js';
import { detectConflicts } from '../../src/domain/consolidate/conflicts.js';
import { deduplicateStore } from '../../src/domain/consolidate/dedupe.js';
import { buildDag, buildEntityProfiles } from '../../src/domain/consolidate/dag.js';
import { storeExtractedFacts } from '../../src/domain/learn/extract.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let home: string;
beforeEach(() => {
  home = makeRoot('sleep-origin');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
});

const fetcher = (text: string) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
const inProject = (entry: MemoryEntry, origin: string | null): MemoryEntry => ({ ...entry, originProject: origin });
const live = () => loadAllEntries(home, 'default').filter((e) => !e.supersededBy);

describe('sleep partitions by origin project', () => {
  it('the merge pass merges within a project only, and the merged row stays in that project', async () => {
    const backbone = 'rotate the staging tls certificates before expiry';
    for (const [origin, marker] of [
      ['proj-b', 'bravomarker'],
      ['proj-c', 'charliemarker'],
    ] as const) {
      writeEntry(home, inProject(createMemory(backbone, { layer: Layer.Episodic }), origin));
      writeEntry(
        home,
        inProject(createMemory(`${backbone} ${marker} notify the on-call channel`, { layer: Layer.Episodic }), origin),
      );
    }

    expect((await consolidate(home, { dryRun: false })).semanticCreated).toBe(2);

    const merged = live().filter((e) => e.source === 'consolidation');
    expect(merged.map((e) => e.originProject).sort()).toEqual(['proj-b', 'proj-c']);
    expect(merged.find((e) => e.originProject === 'proj-b')!.content).not.toContain('charliemarker');
    expect(merged.find((e) => e.originProject === 'proj-c')!.content).not.toContain('bravomarker');
  });

  it('a merge of rows with no known project stays unknown, never user-global', async () => {
    const backbone = 'rotate the staging tls certificates before expiry';
    writeEntry(home, inProject(createMemory(backbone, { layer: Layer.Episodic }), null));
    writeEntry(
      home,
      inProject(createMemory(`${backbone} notify the on-call channel`, { layer: Layer.Episodic }), null),
    );

    await consolidate(home, { dryRun: false });

    expect(
      live()
        .filter((e) => e.source === 'consolidation')
        .map((e) => e.originProject),
    ).toEqual([null]);
  });

  it('dedup keeps one copy per project and still removes a copy within one project', async () => {
    const text = 'the staging database password lives in the team vault under ops';
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-b'));
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-c'));
    writeEntry(home, inProject(createMemory(text, { layer: Layer.Semantic }), 'proj-c'));

    expect((await deduplicateStore(sqliteStore(home))).removed).toBe(1);
    expect(
      live()
        .map((e) => e.originProject)
        .sort(),
    ).toEqual(['proj-b', 'proj-c']);
  });

  it('two projects may hold opposite rules, but a user-global rule still conflicts with a project rule', async () => {
    const now = new Date();
    const rule = (text: string, origin: string, id: string): MemoryEntry => ({
      ...inProject(createMemory(text, {}), origin),
      id,
      created: now.toISOString(),
      lastRetrieved: now.toISOString(),
    });
    const always = rule('always alpha beta gamma', 'proj-b', 'b');
    const never = rule('never alpha beta gamma zeta', 'proj-c', 'c');
    expect(await detectConflicts([always, never], now)).toEqual([]);
    expect(await detectConflicts([always, { ...never, originProject: '' }], now)).toHaveLength(1);
    expect(await detectConflicts([always, { ...never, originProject: 'proj-b', tenantId: 'other' }], now)).toEqual([]);
  });

  it('facts extracted from a project row stay in that project; from an unknown row they stay unknown', async () => {
    for (const origin of ['proj-b', null]) {
      const source = inProject(createMemory(`alice prefers dark mode in ${origin}`, { layer: Layer.Episodic }), origin);
      writeEntry(home, source);
      const [fact] = await storeExtractedFacts(
        sqliteStore(home),
        source,
        [{ content: `alice prefers dark mode (${origin})`, tags: [], valence: 'neutral' }],
        DEFAULT_HALF_LIFE_DAYS,
      );
      expect(live().find((e) => e.id === fact!.id)!.originProject).toBe(origin);
    }
  });

  it('the DAG summarises facts and summaries within a project, and each summary stays in that project', async () => {
    const facts = ['proj-b', 'proj-c'].flatMap((origin) =>
      ['alice filed X', 'alice noted Y', 'alice closed Z'].map((c) =>
        inProject(
          createMemory(`${c} in ${origin}`, {
            layer: Layer.Episodic,
            dagLevel: 1,
            tags: ['extracted', 'speaker:alice'],
          }),
          origin,
        ),
      ),
    );
    for (const f of facts) writeEntry(home, f);

    expect(
      (
        await buildDag(sqliteStore(home), facts, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          llm: anthropicLlm({ apiKey: 'k', fetcher: fetcher('alice files, notes and closes tickets') }),
        })
      ).summariesCreated,
    ).toBe(2);
    const l2s = live().filter((e) => e.dagLevel === 2);
    expect(l2s.map((e) => e.originProject).sort()).toEqual(['proj-b', 'proj-c']);

    const more = ['proj-b', 'proj-c'].map((origin) =>
      inProject(
        createMemory(`alice owns the API layer in ${origin}`, {
          layer: Layer.Semantic,
          tags: ['speaker:alice', 'dag-summary'],
          confidence: 'inferred',
          dagLevel: 2,
        }),
        origin,
      ),
    );
    for (const l2 of more) writeEntry(home, l2);

    expect(
      (
        await buildEntityProfiles(sqliteStore(home), [...l2s, ...more], {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          llm: anthropicLlm({ apiKey: 'k', fetcher: fetcher('alice is the typed-python API owner') }),
        })
      ).profilesCreated,
    ).toBe(2);
    expect(
      live()
        .filter((e) => e.dagLevel === 3)
        .map((e) => e.originProject)
        .sort(),
    ).toEqual(['proj-b', 'proj-c']);
  });
});

describe('conflicts never pair across a personal scope', () => {
  const now = new Date();
  const rule = (text: string, id: string, scope: string | null): MemoryEntry => ({
    ...createMemory(text, { scope }),
    id,
    originProject: 'proj',
    created: now.toISOString(),
    lastRetrieved: now.toISOString(),
  });
  const ALICE = 'personal:private:alice';

  it('a personal row against a team row gives no pair, while two team rows do', async () => {
    const always = rule('always alpha beta gamma', 'a', null);
    const never = rule('never alpha beta gamma zeta', 'b', null);
    expect(await detectConflicts([always, never], now)).toHaveLength(1);
    expect(await detectConflicts([{ ...always, scope: ALICE }, never], now)).toEqual([]);
    expect(await detectConflicts([always, { ...never, scope: ALICE }], now)).toEqual([]);
  });

  it('two rows in one personal scope still pair', async () => {
    const pair = await detectConflicts(
      [rule('always alpha beta gamma', 'a', ALICE), rule('never alpha beta gamma zeta', 'b', ALICE)],
      now,
    );
    expect(pair.map((p) => [p.memory_a_id, p.memory_b_id])).toEqual([['a', 'b']]);
  });

  it('two owners, or a case variant of one owner, never pair', async () => {
    const mine = rule('always alpha beta gamma', 'a', ALICE);
    expect(
      await detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'personal:private:bob')], now),
    ).toEqual([]);
    expect(
      await detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'Personal:private:alice')], now),
    ).toEqual([]);
  });
});
