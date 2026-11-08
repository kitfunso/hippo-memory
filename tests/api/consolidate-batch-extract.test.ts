import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { consolidate } from '../../src/index.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { DAY_MS } from '../../src/base/util/time.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';
import { makeOkFetcher, makeScriptedFetcher, rejectValue } from '../_helpers/dag-rebuild.js';
import { runConsolidation } from '../../src/domain/consolidate/sleep.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/host/config-file.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import type { Llm } from '../../src/base/ports/llm.js';

pinClock();

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('batch-extract', { init: false });
});

describe('Batch extraction during consolidation', () => {
  it('reports extractionCandidates for episodic memories without facts', async () => {
    initTestStore(tmpDir);

    const ep1 = createMemory('the deploy pipeline uses blue-green strategy on kubernetes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    const ep2 = createMemory('redis cache eviction policy is set to allkeys-lru in production', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep1);
    writeEntry(tmpDir, ep2);

    const result = await consolidate(tmpDir, { dryRun: false, now: FIXED_NOW });

    expect(result.extractionCandidates).toBe(2);
    expect(result.extracted).toBe(0);
  });

  it('skips episodic memories that already have extracted facts', async () => {
    initTestStore(tmpDir);

    const ep = createMemory('nginx reverse proxy listens on port 443 with TLS termination', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(tmpDir, ep);

    const fact = createMemory('nginx listens on port 443', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Semantic,
      tags: ['extracted'],
      extractedFrom: ep.id,
    });
    writeEntry(tmpDir, fact);

    const result = await consolidate(tmpDir, { dryRun: false, now: FIXED_NOW });

    expect(result.extractionCandidates).toBe(0);
  });
});

describe('Empty extraction marks', () => {
  const SOURCE = 'the deploy pipeline uses blue-green strategy on kubernetes';
  const FACT = 'Alice prefers the blue-green deploy strategy on kubernetes';
  const FACT_REPLY = JSON.stringify([{ content: FACT, tags: ['speaker:Alice'], valence: 'neutral' }]);
  const GOOD = 'the staging cluster runs on three spot instances in eu-west-2';

  // Pinned, so no decay removes a source between the sleeps of a test.
  const episodic = (content: string, created = FIXED_NOW): MemoryEntry => ({
    ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic, pinned: true }),
    created: created.toISOString(),
  });
  const sleepAt = (fetcher: typeof fetch, days = 0) =>
    consolidate(tmpDir, { now: new Date(FIXED_NOW.getTime() + days * DAY_MS), fetcher });

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    initTestStore(tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips a source the model found nothing in while its text is unchanged and the mark is young', async () => {
    writeEntry(tmpDir, episodic(SOURCE));
    const fetcher = makeOkFetcher('[]');

    const first = await sleepAt(fetcher);
    const second = await sleepAt(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ extractionCandidates: 1, extractionHeld: 0 });
    expect(second).toMatchObject({ extractionCandidates: 0, extractionHeld: 1 });
  });

  it('offers the source again once its text changes', async () => {
    const source = episodic(SOURCE);
    writeEntry(tmpDir, source);
    const fetcher = makeOkFetcher('[]');
    await sleepAt(fetcher);

    writeEntry(tmpDir, { ...source, content: `${SOURCE}, with canary releases first` });
    const second = await sleepAt(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ extractionCandidates: 1, extractionHeld: 0 });
  });

  it('offers the source again after the mark is 30 days old', async () => {
    writeEntry(tmpDir, episodic(SOURCE));
    const fetcher = makeOkFetcher('[]');
    await sleepAt(fetcher);

    await sleepAt(fetcher, 29);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await sleepAt(fetcher, 31);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('marks a source whose every fact a tombstone refuses', async () => {
    writeEntry(tmpDir, episodic(SOURCE));
    rejectValue(tmpDir, 'default', FACT);
    const fetcher = makeOkFetcher(FACT_REPLY);

    const first = await sleepAt(fetcher);
    await sleepAt(fetcher);

    expect(first.extracted).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty reply', ''],
    ['a reply that is not an array', '{}'],
    ['an array of unusable items', '[{"content":"ab"},{"content":42}]'],
  ])('does not mark a source after %s', async (_name, reply) => {
    writeEntry(tmpDir, episodic(SOURCE));
    const fetcher = makeOkFetcher(reply);

    await sleepAt(fetcher);
    const second = await sleepAt(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ extractionCandidates: 1, extractionHeld: 0 });
  });

  it('offers a source behind a full batch of marked ones on the next sleep', async () => {
    const subjects = ['postgres', 'redis', 'nginx', 'kafka', 'vault', 'consul', 'istio', 'envoy', 'airflow'];
    const queue = Array.from({ length: 21 }, (_, i) =>
      episodic(
        `${subjects[i % subjects.length]} backup ${i} runs at ${i + 1}:00 utc under the ${['night', 'day'][i % 2]} schedule`,
        new Date(FIXED_NOW.getTime() - (60 - i) * 1000),
      ),
    );
    for (const source of [...queue, episodic(GOOD, new Date(FIXED_NOW.getTime() - 1000))]) {
      writeEntry(tmpDir, source);
    }
    const fetcher = makeScriptedFetcher((_call, prompt) => (prompt.includes(GOOD) ? FACT_REPLY : '[]'));

    const first = await sleepAt(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(20);
    const second = await sleepAt(fetcher);

    expect(first).toMatchObject({ extractionCandidates: 22, extractionHeld: 0, extracted: 0 });
    expect(second).toMatchObject({ extractionCandidates: 2, extractionHeld: 20, extracted: 1 });
    expect(fetcher).toHaveBeenCalledTimes(22);
  });

  it('offers a marked source again when the marks cannot be read, and the sleep still completes', async () => {
    writeEntry(tmpDir, episodic(SOURCE));
    await sleepAt(makeOkFetcher('[]'));
    const local = sqliteStore(tmpDir);
    const store = {
      ...local,
      consolidation: {
        ...local.consolidation,
        emptyExtractions: () => Promise.reject(new Error('meta read failed')),
      },
    };
    const send = vi.fn<Llm['send']>(async () => ({ ok: true, text: '[]' }));

    const result = await runConsolidation(store, {
      strength: PRODUCTION_STRENGTH,
      now: FIXED_NOW,
      config: loadConfig(tmpDir),
      tenantId: 'default',
      llm: { send },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ extractionCandidates: 1, extractionHeld: 0 });
  });
});
