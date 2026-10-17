// One rule for every endpoint that receives a key or memory text: the embeddings base URL and both rerankers.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOutboundUrl } from '../../src/util/net.js';
import { resolveEmbeddingProvider } from '../../src/embeddings/provider.js';
import { createLlmReranker } from '../../src/rerankers/llm.js';
import { loadConfig } from '../../src/core/config.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/core/search-types.js';

describe('parseOutboundUrl', () => {
  it.each(['https://api.example.com/v1', 'http://localhost:8080', 'http://127.0.0.1:9', 'http://[::1]:1234/v1'])(
    'accepts %s',
    (url) => {
      expect(parseOutboundUrl(url, 'SETTING').href).toBe(new URL(url).href);
    },
  );

  it.each([
    ['plain http to another host', 'http://api.example.com/v1', 'SETTING must use https unless it is on this machine'],
    ['a scheme that is not http', 'ftp://localhost/v1', 'SETTING must be an http or https URL'],
    ['a user and password', 'https://user:pw@api.example.com/v1', 'SETTING must not embed credentials; set KEY'],
    ['a user alone', 'https://user@api.example.com/v1', 'SETTING must not embed credentials; set KEY'],
    ['an unparseable value', 'not a url', 'SETTING is not a valid URL'],
  ])('refuses %s', (_label, url, message) => {
    expect(() => parseOutboundUrl(url, 'SETTING', 'KEY')).toThrow(message);
  });
});

describe('config.embeddings.apiBaseUrl', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-outbound-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = (apiBaseUrl: string) => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm', apiBaseUrl } }));
    return () => resolveEmbeddingProvider(loadConfig(root).embeddings);
  };

  it('accepts plain http to the IPv6 loopback', () => {
    expect(provider('http://[::1]:1234/v1')().id).toBe('openai:m');
  });

  it('refuses a base URL that carries credentials', () => {
    expect(provider('https://user:pw@proxy.example.com/v1')).toThrow('must not embed credentials');
  });

  it('refuses a scheme that is not http, even to this machine', () => {
    expect(provider('ftp://localhost/v1')).toThrow('must be an http or https URL');
  });
});

describe('HIPPO_LLM_RERANKER_URL', () => {
  const head: SearchResult[] = ['alpha', 'beta'].map((content, i) => ({
    entry: createMemory(content), score: 1 - i, bm25: 1 - i, cosine: 0, tokens: 10,
  }));

  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('HIPPO_LLM_RERANKER_KEY', 'reranker-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['http://reranker.example.com', 'https://user:pw@reranker.example.com', 'ftp://localhost'])(
    'never sends the key to %s and keeps the input order',
    async (url) => {
      vi.stubEnv('HIPPO_LLM_RERANKER_URL', url);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const out = await createLlmReranker()('q', head);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out.map((r) => r.entry.content)).toEqual(['alpha', 'beta']);
    },
  );
});
