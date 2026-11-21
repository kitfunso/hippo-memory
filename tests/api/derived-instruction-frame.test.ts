// A fact or summary built from a framed row prints framed too, so its sources' frame tags go with it.
import { describe, expect, it, vi } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { INSTRUCTION_LIKE_TAG, UNTRUSTED_ORIGIN_TAG } from '../../src/base/trust/instruction-detect.js';
import { buildDag, buildEntityProfiles } from '../../src/domain/consolidate/dag.js';
import { storeExtractedFacts } from '../../src/domain/learn/extract.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { pinClock } from '../_helpers/fixed-clock.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore } = sessionPerTest();

pinClock();

const FRAME_TAGS = [INSTRUCTION_LIKE_TAG, UNTRUSTED_ORIGIN_TAG] as const;

function okFetcher(content: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ content: [{ text: content }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('an extracted fact', () => {
  it.each(FRAME_TAGS)('keeps the %s tag of its source', async (tag) => {
    const home = makeRoot('derived-frame');
    const source = createMemory('Alice prefers dark mode and vim keybindings', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      tags: [tag],
    });
    writeEntry(home, source);

    const stored = await storeExtractedFacts(sqliteStore(home), {
      source,
      facts: [{ content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' }],
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      now: evalNow(),
    });

    expect(stored).toHaveLength(1);
    expect(stored[0].tags).toContain(tag);
    expect(loadAllEntries(home, 'default').find((e) => e.id === stored[0].id)?.tags).toContain(tag);
  });

  it('carries no frame tag when its source has none', async () => {
    const home = makeRoot('derived-frame');
    const source = createMemory('Alice prefers dark mode and vim keybindings', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(home, source);

    const [fact] = await storeExtractedFacts(sqliteStore(home), {
      source,
      facts: [{ content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' }],
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      now: evalNow(),
    });

    for (const tag of FRAME_TAGS) expect(fact.tags).not.toContain(tag);
  });
});

describe('a DAG summary and an entity profile', () => {
  it.each(FRAME_TAGS)('keep the %s tag of one member', async (tag) => {
    const home = makeRoot('derived-frame');
    const facts = ['alice filed X', 'alice noted Y', 'alice closed Z'].map((content, i) =>
      createMemory(content, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Episodic,
        dagLevel: 1,
        tags: ['extracted', 'speaker:alice', ...(i === 0 ? [tag] : [])],
      }),
    );
    for (const f of facts) writeEntry(home, f);

    const dag = await buildDag(sqliteStore(home), facts, {
      now: evalNow(),
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      llm: anthropicLlm({ apiKey: 'test-key', fetcher: okFetcher('synthetic-frame-carrying-summary') }),
    });
    expect(dag.summariesCreated).toBe(1);
    const summary = loadAllEntries(home, 'default').find((e) => e.tags.includes('dag-summary'));
    expect(summary?.tags).toContain(tag);

    const l2s = ['alice prefers python type hints', 'alice ships in 2-week cycles', 'alice owns the API layer'].map(
      (content, i) =>
        createMemory(content, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          layer: Layer.Semantic,
          tags: ['speaker:alice', 'dag-summary', ...(i === 0 ? [tag] : [])],
          confidence: 'inferred',
          dagLevel: 2,
        }),
    );
    for (const l2 of l2s) writeEntry(home, l2);
    const profiles = await buildEntityProfiles(sqliteStore(home), l2s, {
      now: evalNow(),
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      llm: anthropicLlm({ apiKey: 'k', fetcher: okFetcher('synthetic-frame-carrying-profile') }),
    });
    expect(profiles.profilesCreated).toBe(1);
    const profile = loadAllEntries(home, 'default').find((e) => e.tags.includes('dag-entity-profile'));
    expect(profile?.tags).toContain(tag);
  });
});
