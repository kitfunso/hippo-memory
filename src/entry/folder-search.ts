// The published hybridSearch and physicsSearch: each fills the hippo.db folder, working-folder and
// eval-switch defaults, then calls the domain ranker of that name. The eval kit's embedMemory and
// loadRecallSearchEntries take a folder the same way.

import type { MemoryEntry } from '../base/memory/entry.js';
import type { SearchResult } from '../base/rank/search-types.js';
import type { OriginFilter } from '../base/ports/store/types.js';
import { defaultStore } from '../surface/open-store.js';
import { listRecallEntriesInFolder } from '../surface/testing-kit.js';
import type { TenantId } from '../base/util/tenant.js';
import {
  embedMemoryInto,
  folderEmbedTarget,
  type EmbedOutcome,
} from '../domain/search/embed-memories.js';
import {
  hybridSearch as rankHybrid,
  vectorSourceOf,
  type HybridSearchOptions,
} from '../domain/search/hybrid.js';
import { loadConfig } from '../host/config-file.js';
import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';
import { rankPhysics, type PhysicsSearchOptions } from '../domain/search/physics-search.js';
import type { VectorSource } from '../domain/search/vector.js';
import { evalNow, evalRun, evalSwitches } from '../infra/eval-switches.js';
import type { EvalSwitches } from '../base/memory/eval-switches.js';

/** A published ranker's options under the environment's eval switches and clock, unless the
 * caller names its own. */
export function withEvalSwitches<
  O extends { readonly switches?: EvalSwitches; readonly now?: Date },
>(options: O): O & { now: Date } {
  return {
    ...options,
    switches: options.switches ?? evalSwitches(),
    now: options.now ?? evalNow(),
  };
}

/** hippo.db under `hippoRoot` when the caller passed no store. */
export function folderVectorSource({
  hippoRoot,
  store,
  embeddings,
}: Pick<HybridSearchOptions, 'hippoRoot' | 'store' | 'embeddings'>): VectorSource | undefined {
  if (!hippoRoot) return undefined;
  const config = { embeddings: embeddings ?? loadConfig(hippoRoot).embeddings };
  return vectorSourceOf({
    store: store ?? defaultStore(hippoRoot),
    config,
    onHippoDb: true,
    embedderFor: resolveEmbeddingProvider,
  });
}

/**
 * BM25 blended with cosine similarity when stored vectors and a provider are available, BM25 *
 * strength * recency otherwise. Reads hippo.db under `hippoRoot` when no `source` or `store` is
 * passed.
 */
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  // GraphStreamOptions names the global store by folder, so it opens here.
  const globalRoot = options.graphStream?.globalRoot;
  return rankHybrid(query, entries, {
    ...withEvalSwitches(options),
    cwd: options.cwd ?? process.cwd(),
    source: options.source ?? folderVectorSource(options),
    graphGlobal:
      globalRoot && globalRoot !== options.hippoRoot ? defaultStore(globalRoot) : undefined,
  });
}

/**
 * Scores memories by gravity, momentum and cluster amplification; rows without physics state rank
 * through hybridSearch. Reads hippo.db under `hippoRoot` when no store is passed.
 */
export async function physicsSearch(
  query: string,
  entries: MemoryEntry[],
  options: PhysicsSearchOptions = {},
): Promise<SearchResult[]> {
  const source = entries.length > 0 ? folderVectorSource(options) : undefined;
  return rankPhysics(query, entries, {
    ...withEvalSwitches(options),
    cwd: options.cwd ?? process.cwd(),
    source,
  });
}

/** The eval kit's folder form of embedMemory, for frozen scripts written against it. */
export async function embedMemory(hippoRoot: string, entry: MemoryEntry): Promise<EmbedOutcome> {
  const store = defaultStore(hippoRoot);
  try {
    const config = loadConfig(hippoRoot);
    const target = folderEmbedTarget(
      { store, config, embedderFor: resolveEmbeddingProvider },
      evalRun(),
    );
    return await embedMemoryInto(target, entry);
  } finally {
    await store.close();
  }
}

type PositionalRecallArgs = [
  hippoRoot: string,
  query: string,
  limit: number | undefined,
  tenantId: TenantId,
  requestedScope?: string,
  explicitScopeMode?: 'exact' | 'additive',
  includeSuperseded?: boolean,
  originProjects?: OriginFilter,
  ownScope?: string,
];

/** The eval kit's positional form of the recall loader, for frozen scripts written against it.
 * It takes one rest parameter, so the frozen q3b-ranker-floor call stays as written and src
 * declares no long positional list. */
export function loadRecallSearchEntries(...args: PositionalRecallArgs): MemoryEntry[] {
  const [
    hippoRoot,
    query,
    limit,
    tenantId,
    requestedScope,
    explicitScopeMode,
    includeSuperseded,
    originProjects,
    ownScope,
  ] = args;
  return listRecallEntriesInFolder(hippoRoot, query, {
    limit,
    tenantId,
    requestedScope,
    explicitScopeMode,
    includeSuperseded,
    originProjects,
    ownScope,
  });
}
