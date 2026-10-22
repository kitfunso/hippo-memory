// H3, H11, L2: sleep calls the LLM only when allowed and never with a secret in the
// prompt, auto-sleep counts only what arrived since the last sleep, and remember
// honours the configured half-life.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { consolidate } from '../../src/index.js';
import { remember } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const DAY = 86_400_000;
const roots: string[] = [];
const FAKE_AWS_KEY = 'AKIA' + 'X'.repeat(16);

function newRoot(configJson?: string): string {
  const root = makeRoot('h3');
  roots.push(root);
  if (configJson) writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

function llmReturning(res: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('real network call in a test');
    }),
  );
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
  return vi.fn<typeof fetch>(async () => res());
}
const emptyFacts = () => new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) removeAfterRequest(r);
});

describe('the sleep LLM gate', () => {
  it('extraction.enabled=false makes no LLM call even with a key set', async () => {
    const root = newRoot(JSON.stringify({ extraction: { enabled: false } }));
    writeEntry(root, createMemory('the release train leaves every second thursday'));
    const fetcher = llmReturning(emptyFacts);

    await consolidate(root, { fetcher });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('with a key set it calls the LLM with secrets redacted from the prompt', async () => {
    const root = newRoot();
    writeEntry(root, createMemory(`the deploy bot uses access key ${FAKE_AWS_KEY} for the bucket`));
    const fetcher = llmReturning(emptyFacts);

    await consolidate(root, { fetcher });

    expect(fetcher).toHaveBeenCalled();
    const body = String(fetcher.mock.calls[0]![1]?.body);
    expect(body).toContain('the deploy bot uses access key');
    expect(body).not.toContain(FAKE_AWS_KEY);
  });

  it('an LLM failure lands in the sleep details', async () => {
    const root = newRoot();
    writeEntry(root, createMemory('the release train leaves every second thursday'));
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetcher = llmReturning(() => new Response('error', { status: 500 }));

    const result = await consolidate(root, { fetcher });

    expect(result.details.join('\n')).toMatch(/extraction.*HTTP 500/);
    expect(errSpy).toHaveBeenCalled();
  });

  describe('a failing extraction call', () => {
    const TOPICS = [
      'the release train leaves every second thursday',
      'the staging cluster restarts at noon',
      'invoices are exported as csv on fridays',
    ];

    function rootWithCandidates(): string {
      const root = newRoot();
      for (const topic of TOPICS) writeEntry(root, createMemory(topic));
      return root;
    }

    it('stops the pass at the first one every later call would repeat, and says how many it skipped', async () => {
      const root = rootWithCandidates();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const fetcher = llmReturning(
        () => new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 }),
      );

      const result = await consolidate(root, { fetcher });

      // The failure stops the launches; calls already in flight, at most three, still land.
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1 + 3);
      const details = result.details.join('\n');
      expect(details).toMatch(/extraction: HTTP 401: .*authentication_error/);
      expect(details).toContain(`2 of ${TOPICS.length} candidates skipped`);
    });

    it('keeps going past a rate limit, which the next call can clear', async () => {
      const root = rootWithCandidates();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const fetcher = llmReturning(
        () => new Response('{"type":"error"}', { status: 429, headers: { 'retry-after': '0' } }),
      );

      const result = await consolidate(root, { fetcher });

      // Three attempts per candidate: the retry policy's own, and no candidate skipped.
      expect(fetcher).toHaveBeenCalledTimes(3 * TOPICS.length);
      expect(result.details.join('\n')).not.toContain('candidates skipped');
    });
  });

  describe('extraction concurrency', () => {
    const COUNT = 10;
    const FAIL_AT = 5;

    function rootWithMany(): string {
      const root = newRoot();
      for (let i = 0; i < COUNT; i++) {
        writeEntry(root, createMemory(`release note number ${i} about the staging cluster`));
      }
      return root;
    }

    function trackedFetcher(failOrdinal: number | null) {
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
      const seen = { launched: 0, inFlight: 0, peak: 0 };
      const fetcher = vi.fn<typeof fetch>(async () => {
        const ordinal = seen.launched++;
        seen.peak = Math.max(seen.peak, ++seen.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.inFlight--;
        if (ordinal === failOrdinal) return new Response('{"type":"error"}', { status: 401 });
        return emptyFacts();
      });
      return { fetcher, seen };
    }

    it('runs at most four calls at once', async () => {
      const { fetcher, seen } = trackedFetcher(null);

      await consolidate(rootWithMany(), { fetcher });

      expect(seen.launched).toBe(COUNT);
      expect(seen.peak).toBeGreaterThan(1);
      expect(seen.peak).toBeLessThanOrEqual(4);
    });

    it('stops launching at a permanent failure and counts the skipped rows by input index', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { fetcher, seen } = trackedFetcher(FAIL_AT);

      const result = await consolidate(rootWithMany(), { fetcher });

      expect(seen.launched).toBeGreaterThan(FAIL_AT);
      expect(seen.launched).toBeLessThanOrEqual(FAIL_AT + 1 + 3);
      expect(result.details.join('\n')).toContain(`${COUNT - FAIL_AT - 1} of ${COUNT} candidates skipped`);
    });
  });

  it('test workers start with no provider keys', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HIPPO_LLM_RERANKER_URL']) {
      expect(process.env[k] ?? '').toBe('');
    }
  });
});

describe('the auto-sleep trigger', () => {
  it('counts only memories created since the last sleep', async () => {
    const root = newRoot();
    writeEntry(root, createMemory('first memory about the release train schedule'));
    writeEntry(root, createMemory('second memory about the staging cluster restarts'));
    expect(await sqliteStore(root).reports.createdSinceLastSleep('default', new Date())).toBe(2);

    await consolidate(root);
    expect(await sqliteStore(root).reports.createdSinceLastSleep('default', new Date())).toBe(0);

    writeEntry(root, createMemory('third memory about invoices exported as csv'));
    expect(await sqliteStore(root).reports.createdSinceLastSleep('default', new Date())).toBe(1);
  });

  it('never counts memories older than 24 hours', async () => {
    const root = newRoot();
    const old = createMemory('an old memory about the quarterly budget review');
    writeEntry(root, { ...old, created: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(await sqliteStore(root).reports.createdSinceLastSleep('default', new Date())).toBe(0);
  });
});

describe('the configured base half-life', () => {
  it('api.remember uses defaultHalfLifeDays from config.json', async () => {
    const root = newRoot(JSON.stringify({ defaultHalfLifeDays: 14 }));
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    const { id } = await remember(ctx, { content: 'the on-call rotation hands over every tuesday' });
    expect(readEntry(root, id)?.halfLifeDays).toBe(14);
  });
});
