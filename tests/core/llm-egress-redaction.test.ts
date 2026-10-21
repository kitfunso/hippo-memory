// The store is not scrubbed at write, so every path that ships memory text off the box must scrub it first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { generateDagSummary } from '../../src/domain/consolidate/dag-summary.js';
import { extractFacts } from '../../src/domain/learn/extract.js';
import { getReranker } from '../../src/infra/rerankers.js';
import { createJevReranker } from '../../src/domain/rerankers/jev.js';
import { processHttp } from '../../src/infra/http.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { loadConfig } from '../../src/base/config/config.js';
import { refineOne } from '../_helpers/refine-one.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SECRET = 'AKIA' + 'Q7'.repeat(8);
// Bearer and JWT shapes only the strict redaction catches; a path on the store redaction would leak them.
const BEARER = 'b'.repeat(24);
const JWT = `eyJ${'h'.repeat(12)}.eyJ${'p'.repeat(12)}.sig`;
const TEXT = `the deploy key is ${SECRET} for prod, header Bearer ${BEARER}, session ${JWT}`;
const ENV = ['HIPPO_LLM_RERANKER_URL', 'HIPPO_LLM_RERANKER_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY'];
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

function expectScrubbed(requests: number): void {
  expect(bodies).toHaveLength(requests);
  for (const body of bodies) {
    expect(body).not.toContain('AKIA');
    expect(body).not.toContain(BEARER);
    expect(body).not.toContain(JWT);
    expect(body).toContain('[REDACTED]');
  }
}

beforeEach(() => {
  bodies = [];
  for (const k of ENV) vi.stubEnv(k, undefined);
  root = mkdtempSync(join(tmpdir(), 'hippo-egress-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('secret redaction before memory text leaves the box', () => {
  it('refine scrubs the merged text, and scrubs a source before cutting it at 400 chars', async () => {
    const source = createMemory(`${'x'.repeat(390)} ${SECRET}`);
    await refineOne(TEXT, [source], {
      llm: anthropicLlm({ apiKey: 'k', fetcher: capture({ content: [{ text: 'a refined principle' }] }) }),
    });
    expectScrubbed(1);
  });

  it('dag summaries and fact extraction scrub their input', async () => {
    await generateDagSummary(TEXT, [TEXT], {
      llm: anthropicLlm({ apiKey: 'k', fetcher: capture({ content: [{ text: 'a summary line' }] }) }),
    });
    await extractFacts(TEXT, { llm: anthropicLlm({ apiKey: 'k', fetcher: capture({ content: [{ text: '[]' }] }) }) });
    expectScrubbed(2);
  });

  it('the hosted rerankers scrub the query and every candidate', async () => {
    vi.stubEnv('HIPPO_LLM_RERANKER_URL', 'http://127.0.0.1:9');
    vi.stubGlobal('fetch', capture({ choices: [{ message: { content: '[0]' } }] }));
    await getReranker('llm')!(TEXT, [hit(TEXT)]);
    vi.stubEnv('TYPESAFE_API_KEY', 'test-' + 'k'.repeat(8));
    vi.stubGlobal('fetch', capture({ answers: { c1: { noul: 0.5 } } }));
    await createJevReranker(async () => [], processHttp)(TEXT, [hit(TEXT)]);
    expectScrubbed(2);
  });

  it('an API embedder scrubs what it sends', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-' + 'k'.repeat(8));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai' } }));
    vi.stubGlobal('fetch', capture({ data: [{ embedding: [1, 0] }] }));
    await resolveEmbeddingProvider(loadConfig(root).embeddings).embed([TEXT], 'passage');
    expectScrubbed(1);
  });
});
