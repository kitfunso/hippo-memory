// H3, H11, L2: sleep calls the LLM only when allowed and never with a secret in the
// prompt, auto-sleep counts only what arrived since the last sleep, and remember
// honours the configured half-life.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { initStore, writeEntry, readEntry, countCreatedSinceLastSleep } from '../src/store.js';
import { consolidate } from '../src/consolidate.js';
import { remember, type Context } from '../src/api.js';

const DAY = 86_400_000;
const roots: string[] = [];
const FAKE_AWS_KEY = 'AKIA' + 'X'.repeat(16);

function newRoot(configJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-h3-'));
  roots.push(root);
  initStore(root);
  if (configJson) writeFileSync(join(root, 'config.json'), configJson);
  return root;
}

function llmReturning(res: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('real network call in a test'); }));
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
  return vi.fn<typeof fetch>(async () => res());
}
const emptyFacts = () => new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('H3: the sleep LLM gate', () => {
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
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = llmReturning(() => new Response('error', { status: 500 }));

    const result = await consolidate(root, { fetcher });

    expect(result.details.join('\n')).toMatch(/extraction.*HTTP 500/);
    expect(errSpy).toHaveBeenCalled();
  });

  it('test workers start with no provider keys', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HIPPO_LLM_RERANKER_URL']) {
      expect(process.env[k] ?? '').toBe('');
    }
  });
});

describe('H11: the auto-sleep trigger', () => {
  it('counts only memories created since the last sleep', async () => {
    const root = newRoot();
    writeEntry(root, createMemory('first memory about the release train schedule'));
    writeEntry(root, createMemory('second memory about the staging cluster restarts'));
    expect(countCreatedSinceLastSleep(root, 'default')).toBe(2);

    await consolidate(root);
    expect(countCreatedSinceLastSleep(root, 'default')).toBe(0);

    writeEntry(root, createMemory('third memory about invoices exported as csv'));
    expect(countCreatedSinceLastSleep(root, 'default')).toBe(1);
  });

  it('never counts memories older than 24 hours', () => {
    const root = newRoot();
    const old = createMemory('an old memory about the quarterly budget review');
    writeEntry(root, { ...old, created: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(countCreatedSinceLastSleep(root, 'default')).toBe(0);
  });
});

describe('L2: the configured base half-life', () => {
  it('api.remember uses defaultHalfLifeDays from config.json', () => {
    const root = newRoot(JSON.stringify({ defaultHalfLifeDays: 14 }));
    const ctx: Context = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    const { id } = remember(ctx, { content: 'the on-call rotation hands over every tuesday' });
    expect(readEntry(root, id)?.half_life_days).toBe(14);
  });
});
