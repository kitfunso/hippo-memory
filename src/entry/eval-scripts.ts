// The functions eval and benchmark scripts call by name, with the real embedder, models, HTTP and
// ports wired in: a frozen script re-points its import line here and keeps every call as written.
import { folderEmbedTarget, type EmbedTarget } from '../domain/search/embed-memories.js';
import { rankHybrid, type HybridRankOptions } from '../domain/search/hybrid.js';
import { outcomeBoostFor } from '../domain/search/boosts.js';
import { evalNow, evalSwitches, isOutcomeFastAblated } from '../infra/eval-switches.js';
// Frozen eval scripts set HIPPO_FAKE_NOW per simulated session and read the clock and the
// recall-boost switch here.
export { evalNow, isRecallBoostAblated } from '../infra/eval-switches.js';
import type { MemoryEntry } from '../base/memory/entry.js';
import type { SearchResult } from '../base/rank/search-types.js';
import type { ConfiguredFolder } from '../base/config/configured-folder.js';
import type { HippoStore } from '../base/ports/store.js';
import { withHippoDb } from '../api/hippo-db-context.js';
import { judgeOver, type JudgeOptions, type Judgment } from '../infra/judgment.js';
import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';
import { httpOver } from '../infra/http.js';
import { realRerankers } from '../infra/rerankers/index.js';
import * as api from '../api/index.js';
import type {
  EntryContext,
  GatedRememberOptions,
  RememberOptions,
  RememberResult,
  RememberSkipped,
} from '../api/index.js';
import { ingestEvent as ingestGithubEvent } from '../surface/connectors/github/ingest.js';
import { ingestMessage as ingestSlackMessage } from '../surface/connectors/slack/ingest.js';
import type { ConnectorContext } from '../surface/connectors/ingest.js';
import { entryInfra, filled } from '../surface/entry-infra.js';

// The target a folderIndex builds carries the embedder, so embedAll needs no wiring of its own.
export { embedAll } from '../domain/search/embed-memories.js';

/** The script's reranker registry: an entry is a root, so it builds one for the process and
 * keeps it. */
const scriptRerankers = realRerankers();
export { scriptRerankers as getReranker };

/** A folder's embedding target, embedding with the real provider its config names. */
export function folderIndex(
  folder: Omit<ConfiguredFolder<HippoStore>, 'embedderFor'>,
): EmbedTarget {
  return folderEmbedTarget({ ...folder, embedderFor: resolveEmbeddingProvider }, entryInfra());
}

/** rankHybrid under the environment's eval switches and clock, with no folder
 * defaults filled. */
export function rankHybridWithEvalSwitches(
  query: string,
  entries: MemoryEntry[],
  options: HybridRankOptions = {},
): Promise<SearchResult[]> {
  return rankHybrid(query, entries, {
    switches: evalSwitches(),
    ...options,
    now: options.now ?? evalNow(),
  });
}

/** The outcome nudge, off when HIPPO_ABLATE_OUTCOME or _OUTCOME_FAST is set and the caller
 * passes no `ablated`. */
export function outcomeMultiplier(
  entry: MemoryEntry,
  ablated: boolean = isOutcomeFastAblated(),
): number {
  return outcomeBoostFor(entry, ablated);
}

/** judgeAll's options as a script passes them: the real fetch unless `fetcher` names another. */
export type JudgeConnection = Omit<JudgeOptions, 'http'> & { readonly fetcher?: typeof fetch };

/** Judge many candidates under a bounded concurrency pool, order preserved. */
export function judgeAll(
  contents: readonly string[],
  opts: JudgeConnection,
): Promise<(Judgment | null)[]> {
  const { fetcher, ...rest } = opts;
  return judgeOver(contents, { ...rest, http: httpOver(fetcher) });
}

// filled() types a function by its last overload, so the gated form is named here.
export const remember: {
  (ctx: EntryContext, opts: GatedRememberOptions): Promise<RememberResult | RememberSkipped>;
  (ctx: EntryContext, opts: RememberOptions): Promise<RememberResult>;
} = filled(api.remember);
export const retrieve = filled(api.retrieve);
export const retrieveRanking = filled(api.retrieveRanking);
export const retrieveWithCliCore = filled(api.retrieveWithCliCore);
/** A connector ingest on the store its script opened; a store without hippo.db's local tier
 * refuses before it writes. */
function connector<A extends unknown[], R>(
  fn: (ctx: ConnectorContext, ...args: A) => R,
): (ctx: EntryContext, ...args: A) => R {
  return filled<A, R>((ctx, ...args) => fn(withHippoDb(ctx), ...args));
}
export const ingestEvent = connector(ingestGithubEvent);
export const ingestMessage = connector(ingestSlackMessage);
export { adminActor, goalPush, outcome } from '../api/index.js';
export type { EntryContext as Context } from '../api/index.js';
export type { DetachedWork } from '../domain/search/detached-work.js';
