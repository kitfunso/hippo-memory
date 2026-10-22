// The api runs remember, recall, context and sleep on the ports its Context carries: fakes here and a real SQLite
// store. check-layers keeps src/infra out of src/api's imports; this proves the calls go to the fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { adminActor, contextGet, remember, sleep } from '../../src/api/index.js';
import { retrieveWithCliCore } from '../../src/api/recall/request.js';
import { recallRerankerPick } from '../../src/api/recall/rows.js';
import { contextReach, type ContextWith } from '../../src/api/types.js';
import { loadConfig } from '../../src/host/config-file.js';
import type { EmbedderFor, EmbeddingProvider } from '../../src/base/ports/embedder.js';
import type { InfraPorts } from '../../src/base/ports/infra.js';
import type { Llm, LlmRequest } from '../../src/base/ports/llm.js';
import type { RerankerFn } from '../../src/base/ports/reranker.js';
import type { AgentFiles } from '../../src/base/util/agent-files.js';
import type { OptionalGroup } from '../../src/store/port.js';
import { sqliteReach, sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { cwdProject } from '../_helpers/api-ctx.js';

let network: ReturnType<typeof vi.fn>;

interface FakeInfra {
  readonly infra: InfraPorts;
  readonly prompts: LlmRequest[];
  readonly reranked: string[];
  readonly embedders: string[];
  readonly fileReads: string[];
}

function fakeInfra(cwd: string): FakeInfra {
  const prompts: LlmRequest[] = [];
  const reranked: string[] = [];
  const embedders: string[] = [];
  const fileReads: string[] = [];
  const llm: Llm = {
    send: async (request) => {
      prompts.push(request);
      return { ok: true, text: '[]' };
    },
  };
  const rerank: RerankerFn = async (query, results) => {
    reranked.push(query);
    return results.map((r, i) => ({
      ...r,
      rerankScore: results.length - i,
      preRerankRank: i + 1,
      postRerankRank: i + 1,
    }));
  };
  const provider: EmbeddingProvider = {
    kind: 'local',
    model: 'fake',
    id: 'fake',
    isAvailable: () => false,
    embed: async () => [],
  };
  const embedderFor: EmbedderFor = (embeddings) => {
    embedders.push(String(embeddings.model ?? ''));
    return provider;
  };
  const read =
    (name: string) =>
    (...args: unknown[]): never => {
      fileReads.push(`${name} ${String(args[0])}`);
      throw new Error(`the fake machine reads no disk: ${name}`);
    };
  const files: AgentFiles = {
    exists: read('exists'),
    isFolder: read('isFolder'),
    folderNames: read('folderNames'),
    readHead: read('readHead'),
    readText: read('readText'),
    listFiles: read('listFiles'),
    realPath: read('realPath'),
  };
  const machine = {
    home: cwd,
    env: {},
    platform: process.platform,
    files,
    git: { run: read('git') },
    cwd,
    projectIdentity: read('projectIdentity'),
    globalRoot: read('globalRoot'),
    isGlobalRoot: read('isGlobalRoot'),
  };
  const infra: InfraPorts = {
    machine,
    llm,
    embedderFor,
    reranker: (name) => (name === 'fake' ? rerank : null),
  };
  return { infra, prompts, reranked, embedders, fileReads };
}

let hippoRoot: string;

beforeEach(() => {
  hippoRoot = makeRoot('fake-infra');
  vi.stubEnv('HIPPO_HOME', makeRoot('fake-infra-global', { init: false }));
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  network = vi.fn(async () => {
    throw new Error('real network call in a test');
  });
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function contextOn(fake: FakeInfra): ContextWith<OptionalGroup> {
  const store = sqliteStore(hippoRoot);
  return {
    tenantId: 'default',
    actor: adminActor('fake-infra'),
    store,
    reach: contextReach(sqliteReach(hippoRoot, store), loadConfig, fake.infra.embedderFor),
    config: loadConfig(hippoRoot),
    infra: fake.infra,
  };
}

describe('the api on fake infra ports', () => {
  it('remembers, recalls through the reranker, builds context and sleeps through the llm on the fakes alone', async () => {
    const fake = fakeInfra(join(hippoRoot, '..'));
    const ctx = contextOn(fake);
    const config = ctx.config;

    await remember(ctx, { content: 'the release train leaves every second thursday from platform nine' });
    await remember(ctx, {
      content: 'the release notes are drafted on the wednesday before the train',
      kind: 'distilled',
    });

    const picked = recallRerankerPick(ctx, 'fake');
    expect(picked).not.toBeNull();
    const recalled = await retrieveWithCliCore(
      ctx,
      { query: 'release train' },
      {
        rank: {
          budget: 4000,
          cost: (r) => r.tokens,
          window: { limit: 10 },
          includeSuperseded: false,
          explicitScope: null,
          activeScope: null,
          reranker: { fn: picked!.fn, topK: picked!.defaultTopK },
          search: {
            usePhysics: false,
            physicsConfig: config.physics,
            multihop: false,
            mmr: false,
            mmrLambda: 0.7,
            localBump: 1.2,
            explain: false,
          },
        },
        show: (ranking) => ({ results: ranking.results, audit: [], tokens: 0 }),
        lastRecall: ctx.store.lastRecall,
      },
    );
    expect(recalled.results.length).toBeGreaterThan(0);
    expect(fake.reranked).toEqual(['release train']);

    const context = await contextGet(ctx, { currentProject: cwdProject() });
    expect(context.entries.length).toBeGreaterThan(0);

    await sleep(ctx, { noShare: true });
    expect(fake.prompts.length).toBeGreaterThan(0);
    expect(fake.prompts[0]!.prompt).toContain('release');

    expect(fake.embedders.length).toBeGreaterThan(0);
    expect(fake.fileReads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('a Context with no infra fails at the api, not deep in a real service', async () => {
    const { infra: _unused, ...bare } = contextOn(fakeInfra(join(hippoRoot, '..')));
    await expect(sleep(bare, { noShare: true })).rejects.toThrow('this Context has no infra');
    expect(network).not.toHaveBeenCalled();
  });
});
