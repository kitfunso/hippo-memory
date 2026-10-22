// The functions eval and benchmark scripts call by name, with the real embedder, models, HTTP and ports wired in: a
// frozen script re-points its import line here and keeps every call as written.
import { folderIndex as targetOf, type ConfiguredFolder, type EmbedTarget } from '../domain/search/embed-memories.js';
import { judgeAll as judgeOver, type JudgeOptions, type Judgment } from '../infra/judgment.js';
import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';
import { httpOver } from '../infra/http.js';
import { realRerankers } from '../infra/rerankers/index.js';
import * as api from '../api/index.js';
import type { Context, GatedRememberOptions, RememberOptions, RememberResult, RememberSkipped } from '../api/index.js';
import type { InfraPorts } from '../base/ports/infra.js';
import { ingestEvent as ingestGithubEvent } from '../surface/connectors/github/ingest.js';
import { ingestMessage as ingestSlackMessage } from '../surface/connectors/slack/ingest.js';
import { withEntryInfra } from '../surface/entry-infra.js';

// The target a folderIndex builds carries the embedder, so embedAll needs no wiring of its own.
export { embedAll } from '../domain/search/embed-memories.js';

/** The script's reranker registry: an entry is a root, so it builds one for the process and keeps it. */
const scriptRerankers = realRerankers();
export { scriptRerankers as getReranker };

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

/** `fn` with the entry's real ports filled into a Context its script built without them. */
function filled<C extends { readonly infra?: InfraPorts }, A extends unknown[], R>(
  fn: (ctx: C, ...args: A) => R,
): (ctx: C, ...args: A) => R {
  return (ctx, ...args) => fn(withEntryInfra(ctx), ...args);
}

export function remember(ctx: Context, opts: GatedRememberOptions): Promise<RememberResult | RememberSkipped>;
export function remember(ctx: Context, opts: RememberOptions): Promise<RememberResult>;
export function remember(
  ctx: Context,
  opts: RememberOptions | GatedRememberOptions,
): Promise<RememberResult | RememberSkipped> {
  // A plain RememberOptions is a GatedRememberOptions with the gate off.
  return api.remember(withEntryInfra(ctx), { salienceGate: false, ...opts });
}
export const retrieve = filled(api.retrieve);
export const retrieveRanking = filled(api.retrieveRanking);
export const retrieveWithCliCore = filled(api.retrieveWithCliCore);
export const ingestEvent = filled(ingestGithubEvent);
export const ingestMessage = filled(ingestSlackMessage);
export { adminActor, goalPush, outcome } from '../api/index.js';
export type { Context } from '../api/index.js';
