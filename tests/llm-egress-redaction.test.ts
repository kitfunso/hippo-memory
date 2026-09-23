// The store is not scrubbed at write, so every path that ships memory text off the box must scrub it first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import type { SearchResult } from '../src/search.js';
import { refineSemanticMemory } from '../src/refine-llm.js';
import { generateDagSummary } from '../src/dag.js';
import { extractFacts } from '../src/extract.js';
import { llmReranker } from '../src/rerankers/llm.js';
import { createJevReranker } from '../src/rerankers/jev.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import type { JsonValue } from '../src/working-memory.js';

const SECRET = 'AKIA' + 'Q7'.repeat(8);
const TEXT = `the deploy key is ${SECRET} for prod`;
const ENV = ['HIPPO_LLM_RERANKER_URL', 'HIPPO_LLM_RERANKER_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY'];
const saved: Record<string, string | undefined> = {};
let bodies: string[];
let root: string;

function capture(reply: JsonValue): typeof fetch {
  return async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify(reply), { status: 200 });
  };
}

function hit(content: string): SearchResult {
  return { entry: createMemory(content), score: 1, bm25: 1, cosine: 0, tokens: 10 };
}

function expectScrubbed(): void {
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body).not.toContain('AKIA');
    expect(body).toContain('[REDACTED]');
  }
}

beforeEach(() => {
  bodies = [];
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  root = mkdtempSync(join(tmpdir(), 'hippo-egress-'));
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('secret redaction before memory text leaves the box', () => {
  it('refine scrubs the merged text, and scrubs a source before cutting it at 400 chars', async () => {
    const source = createMemory(`${'x'.repeat(390)} ${SECRET}`);
    await refineSemanticMemory(TEXT, [source], {
      apiKey: 'k',
      fetcher: capture({ content: [{ text: 'a refined principle' }] }),
    });
    expectScrubbed();
  });

  it('dag summaries and fact extraction scrub their input', async () => {
    await generateDagSummary(TEXT, [TEXT], { apiKey: 'k', fetcher: capture({ content: [{ text: 'a summary line' }] }) });
    await extractFacts(TEXT, { apiKey: 'k', fetcher: capture({ content: [{ text: '[]' }] }) });
    expectScrubbed();
  });

  it('the hosted rerankers scrub the query and every candidate', async () => {
    process.env.HIPPO_LLM_RERANKER_URL = 'http://127.0.0.1:9';
    vi.stubGlobal('fetch', capture({ choices: [{ message: { content: '[0]' } }] }));
    await llmReranker(TEXT, [hit(TEXT)]);
    process.env.TYPESAFE_API_KEY = 'test-' + 'k'.repeat(8);
    vi.stubGlobal('fetch', capture({ answers: { c1: { noul: 0.5 } } }));
    await createJevReranker(async () => [])(TEXT, [hit(TEXT)]);
    expect(bodies).toHaveLength(2);
    expectScrubbed();
  });

  it('an API embedder scrubs what it sends', async () => {
    process.env.OPENAI_API_KEY = 'test-' + 'k'.repeat(8);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai' } }));
    vi.stubGlobal('fetch', capture({ data: [{ embedding: [1, 0] }] }));
    await resolveEmbeddingProvider(root).embed([TEXT], 'passage');
    expectScrubbed();
  });
});
