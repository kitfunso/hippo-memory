// The memory writes four CLI verbs make (remember, forget, archive, promote), behind one interface with two
// implementations: the store itself, or the `hippo serve` that answers for the folder. Each command picks one, once.

import type { ConfidenceLevel, MemoryEntry, MemoryKind } from '../../base/memory/entry.js';
import { Layer } from '../../base/memory/entry.js';
import { RawAppendOnlyError } from '../../base/errors/raw-append-only.js';
import { envRequireServer } from '../../base/util/env.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import * as api from '../../api/index.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { type ServerInfo, detectServer, removePidfileIfOwned } from '../server/server-detect.js';
import { callerKey } from '../server/local-key.js';
import * as client from './client.js';
import { type CliContext, cliApiContext } from './api-context.js';
import { fail } from './exit.js';
import { requireInit } from './shared.js';

/** One `hippo remember`, every flag parsed and checked. */
export interface RememberRequest {
  readonly content: string;
  /** Every tag the row stores, the path and scope tags of this process included. */
  readonly tags: readonly string[];
  /** The tags the caller typed, which schema fit is scored on. */
  readonly fitTags: readonly string[];
  readonly kind: MemoryKind | undefined;
  readonly scope: string | undefined;
  readonly owner: string | undefined;
  readonly artifactRef: string | undefined;
  // Only a write on the store honours the fields below, as the server sets its own; the verb writes locally for them.
  readonly pinned: boolean;
  readonly confidence: ConfidenceLevel;
  readonly force: boolean;
  readonly extract: boolean;
  readonly source: string;
}

/** `stored`: written here, with the row as the store holds it. `relayed`: the server at `via` wrote it. */
export type Remembered =
  | { readonly status: 'skipped'; readonly reason: string; readonly score: number }
  | {
      readonly status: 'stored';
      readonly entry: MemoryEntry;
      readonly startedWeak?: api.StartedWeak;
      readonly warnings: readonly string[];
      /** Runs fact extraction on the row; the verb calls it once it has reported the write. */
      readonly extraction: () => Promise<api.FactExtraction>;
    }
  | {
      readonly status: 'relayed';
      readonly id: string;
      readonly kind: MemoryKind;
      readonly tenantId: string;
      readonly via: string;
      readonly startedWeak?: api.StartedWeak;
      readonly warnings: readonly string[];
    };

export interface Promoted {
  readonly globalId: string;
  /** The global store's folder, when this process wrote the copy. */
  readonly globalStore?: string;
}

/** The same writes on the store and on the server. A refusal prints its reason and throws CliExit(1). */
export interface MemoryWrites {
  remember(request: RememberRequest): Promise<Remembered>;
  forget(id: string): Promise<void>;
  archive(id: string, reason: string): Promise<void>;
  promote(id: string): Promise<Promoted>;
}

const SERVED_KEY_HINT =
  'hippo serve is running, so the CLI acts as the key in HIPPO_API_KEY, or as the member key in server.key without ' +
  'one: set HIPPO_API_KEY to that key or an admin key.';

/** What `hippo forget <id>` says when the store refuses it; the dry run says the same. */
export async function forgetRefusal(ctx: api.Context, id: string, cause: unknown): Promise<string> {
  if (cause instanceof RawAppendOnlyError) {
    return (
      `Cannot forget ${id}: it is a raw, append-only memory. ` +
      `Archive it instead: hippo forget ${id} --archive --reason "<why>"`
    );
  }
  // Sleep moved it to the dormant store, so point at the command that owns it.
  if (await api.isDormant(ctx, id)) {
    return (
      `${id} is dormant, not in active memory. Delete it for good: hippo dormant forget ${id} ` +
      `(or bring it back: hippo dormant restore ${id})`
    );
  }
  return `Memory not found: ${id}`;
}

/** What `hippo forget <id> --archive` says when it is refused; the dry run says the same. */
export function archiveRefusal(id: string, reason: string): string {
  return `Could not archive ${id}: ${reason}`;
}

function promoteRefusal(reason: string): string {
  return `Failed to promote: ${reason}`;
}

/** The writes on the store at `root`, which must exist by the time one runs. */
export function localWrites(root: string, tenantId: string): MemoryWrites {
  const context = (): CliContext => {
    requireInit(root);
    return cliApiContext(root, tenantId);
  };
  return {
    remember: (request) => rememberHere(context(), request),
    async forget(id) {
      const ctx = context();
      try {
        await api.forget(ctx, id);
      } catch (err) {
        fail(await forgetRefusal(ctx, id, err));
      }
    },
    async archive(id, reason) {
      const ctx = context();
      try {
        await api.rawArchive(ctx, id, reason);
      } catch (err) {
        fail(archiveRefusal(id, errorMessage(err)));
      }
    },
    async promote(id) {
      const ctx = context();
      try {
        const { globalId } = await api.promote(ctx, id);
        return { globalId, globalStore: hippoHomeDir() };
      } catch (err) {
        fail(promoteRefusal(errorMessage(err)));
      }
    },
  };
}

async function rememberHere(ctx: CliContext, request: RememberRequest): Promise<Remembered> {
  const outcome = await api.rememberLocally(ctx, {
    content: request.content,
    kind: request.kind,
    scope: request.scope,
    owner: request.owner,
    artifactRef: request.artifactRef,
    tags: request.tags,
    fitTags: request.fitTags,
    layer: Layer.Episodic,
    pinned: request.pinned,
    source: request.source,
    confidence: request.confidence,
    force: request.force,
  });
  if (outcome.status === 'skipped') return outcome;
  const { entry, startedWeak, warnings } = outcome;
  const extraction = () => api.extractRememberedFacts(ctx, entry, { requested: request.extract });
  return { status: 'stored', entry, warnings, extraction, startedWeak };
}

/** Falling back to the store would mask a misconfiguration and drop HIPPO_API_KEY, so HIPPO_REQUIRE_SERVER throws. */
function failIfServerRequired(reason: string): void {
  if (envRequireServer()) {
    throw new Error(
      `hippo: HIPPO_REQUIRE_SERVER is set but ${reason}. ` +
        `Start \`hippo serve\`, or unset HIPPO_REQUIRE_SERVER to allow direct-mode fallback.`,
    );
  }
}

/** The writes for this command: to the `hippo serve` that answers for `hippoRoot`, else on its store. */
export async function pickWrites(hippoRoot: string, tenantId: string): Promise<MemoryWrites> {
  const local = localWrites(hippoRoot, tenantId);
  const server = await detectServer(hippoRoot);
  if (server) return serverWrites(hippoRoot, server, local);
  failIfServerRequired('no running server was detected for this hippoRoot');
  return local;
}

/** Turns an answer the server refused into the verb's own message. */
type Refused = (err: Error) => never;

/** A refused remember reaches runCli as it is, which prints its message. */
const passOn: Refused = (err) => {
  throw err;
};

/** The server's reason, with the key hint when it refused this caller's rights. */
function servedReason(err: Error): string {
  const refused = err instanceof client.HttpResponseError && err.status === 403;
  return refused ? `${errorMessage(err)}. ${SERVED_KEY_HINT}` : errorMessage(err);
}

function serverWrites(hippoRoot: string, server: ServerInfo, local: MemoryWrites): MemoryWrites {
  const apiKey = callerKey(hippoRoot);
  const send = <T>(
    request: () => Promise<T>,
    refused: Refused,
    fallBack: () => Promise<T>,
  ): Promise<T> => sendOrFallBack(hippoRoot, server, { request, refused, fallBack });
  return {
    remember: (request) =>
      send(
        async () =>
          relayed(server, await client.postRemember(server.url, apiKey, relayedRequest(request))),
        passOn,
        () => local.remember(request),
      ),
    forget: (id) =>
      send(
        async () => {
          await client.postForget(server.url, apiKey, id);
        },
        (err) => fail(servedReason(err)),
        () => local.forget(id),
      ),
    archive: (id, reason) =>
      send(
        async () => {
          await client.postArchiveRaw(server.url, apiKey, id, reason);
        },
        (err) => fail(archiveRefusal(id, servedReason(err))),
        () => local.archive(id, reason),
      ),
    promote: (id) =>
      send(
        async () => ({ globalId: (await client.postPromote(server.url, apiKey, id)).globalId }),
        (err) => fail(promoteRefusal(errorMessage(err))),
        () => local.promote(id),
      ),
  };
}

function relayedRequest(request: RememberRequest): api.RememberOptions {
  const { content, kind, scope, owner, artifactRef } = request;
  return { content, kind, scope, owner, artifactRef, tags: [...request.tags] };
}

function relayed(server: ServerInfo, reply: api.RememberResult | api.RememberSkipped): Remembered {
  if ('skipped' in reply) return { status: 'skipped', ...reply.skipped };
  const { id, kind, tenantId, startedWeak, warnings = [] } = reply;
  return { status: 'relayed', id, kind, tenantId, via: server.url, warnings, startedWeak };
}

interface ServedCall<T> {
  readonly request: () => Promise<T>;
  readonly refused: Refused;
  /** The same write on the store, for a request the server never got. */
  readonly fallBack: () => Promise<T>;
}

/** Sends one write. A request that never left runs on the store and heals the stale pidfile; one that may have landed
 * is never replayed, as every write here is non-idempotent. */
async function sendOrFallBack<T>(
  hippoRoot: string,
  server: ServerInfo,
  call: ServedCall<T>,
): Promise<T> {
  try {
    return await call.request();
  } catch (err) {
    // The client throws only Error, so anything else is a bug for runCli to report as it is.
    if (!(err instanceof Error)) throw err;
    const failure = client.classifyTransportFailure(err);
    if (failure === 'none') return call.refused(err);
    if (failure === 'delivery-unknown') {
      fail(
        `hippo: the connection to ${server.url} dropped or timed out mid-request, so the write may already have been ` +
          'applied. Not retrying locally. Check with `hippo recall` before running this again.',
      );
    }
    failIfServerRequired('the server pidfile was stale (connection refused)');
    log.warn('stale server pidfile detected, falling back to direct mode', errorFields(err));
    // Removed only if it still names the dead server: a newer server may have rewritten it since the probe.
    removePidfileIfOwned(hippoRoot, { pid: server.pid, startedAt: server.started_at });
    return call.fallBack();
  }
}
