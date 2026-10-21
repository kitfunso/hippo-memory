// The domain functions eval and benchmark scripts call by name, with the real embedder, models and HTTP wired in: a
// frozen script re-points its import line here and keeps every call as written.
import { folderIndex as targetOf, type ConfiguredFolder, type EmbedTarget } from '../domain/search/embed-memories.js';
import { judgeAll as judgeOver, type JudgeOptions, type Judgment } from '../domain/eval/judgment.js';
import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';
import { httpOver } from '../infra/http.js';

// The target a folderIndex builds carries the embedder, so embedAll needs no wiring of its own.
export { embedAll } from '../domain/search/embed-memories.js';
export { getReranker } from '../infra/rerankers.js';

/** A folder's embedding target, embedding with the real provider its config names. */
export function folderIndex(folder: Omit<ConfiguredFolder, 'embedderFor'>): EmbedTarget {
  return targetOf({ ...folder, embedderFor: resolveEmbeddingProvider });
}

/** judgeAll's options as a script passes them: the real fetch unless `fetcher` names another. */
export type JudgeConnection = Omit<JudgeOptions, 'http'> & { readonly fetcher?: typeof fetch };

/** Judge many candidates under a bounded concurrency pool, order preserved. */
export function judgeAll(contents: readonly string[], opts: JudgeConnection): Promise<(Judgment | null)[]> {
  const { fetcher, ...rest } = opts;
  return judgeOver(contents, { ...rest, http: httpOver(fetcher) });
}
