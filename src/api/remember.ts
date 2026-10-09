// Write path: remember stores one memory after secret vetting and, for untrusted content, the instruction check.

import { stampOriginProject } from '../store/entry-row.js';
import type { ConnectorEvent, ConnectorWrite, ConnectorWriteOutcome } from '../store/port.js';
import { detectInstruction } from '../instruction-detect.js';
import { quarantineScopeFor } from '../quarantine.js';
import { createMemory, type MemoryEntry, type MemoryKind } from '../memory.js';
import { loadConfig } from '../config.js';
import { vetSecrets } from '../secret-detect.js';
import { assertCallerProject } from '../project-identity.js';
import { BadRequestError } from '../api-errors.js';
import { assertClientScope, personalScopeOf } from '../recall-scope.js';
import { andThen, notPorted, onStore } from './on-store.js';
import type { Context, StoreReply } from './types.js';

export interface RememberOpts {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
  /** The connector event this write answers. The store logs it in the memory's own transaction; an event logged before stores nothing and answers `duplicate`. */
  event?: ConnectorEvent;
  /** Connector-ingested content an agent doesn't control; gates detectInstruction. CLI/HTTP/MCP never set this. */
  untrusted?: boolean;
  /** The caller's project: its name becomes the row's origin. Without it the store's fallback applies (NULL on a shared store). */
  project?: { readonly name: string; readonly aliases?: readonly string[] };
  /** Store it in the caller's own personal scope, readable by its owner alone in every project; needs an owner on the actor and no `scope`. */
  personal?: boolean;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
  /** Set only when untrusted content was flagged and quarantined instead of stored under its requested scope. */
  quarantined?: { reason: string };
  /** Set only when the content held secret material: untrusted text had it redacted, typed text was stored as sent. */
  warnings?: string[];
  /** Set only when the write's event was logged before: nothing was stored, so `id` names no row; `memoryId` is the id the first write logged. */
  duplicate?: { memoryId: string | null };
}

/** The scope a write lands in: the caller's own personal scope when asked for, else the client's, which may not be a personal one. */
function rememberScope(ctx: Context, opts: RememberOpts): string | null {
  if (!opts.personal) {
    assertClientScope(opts.scope);
    return opts.scope ?? null;
  }
  if (opts.untrusted) throw new Error('personal memories come from their owner, never from a connector');
  if (opts.scope !== undefined) throw new BadRequestError('send personal or scope, not both');
  const own = personalScopeOf(ctx.actor);
  if (own === null) {
    throw new BadRequestError('personal memories need a key its owner minted, or a sign-in; owner ids over 239 characters or with control characters cannot hold them');
  }
  return own;
}

/** The vetted row a remember writes, with its scope and quarantine verdict, decided the same way on both paths. */
interface PreparedRemember {
  readonly entry: MemoryEntry;
  readonly requestedScope: string | null;
  readonly detection: { readonly flagged: boolean; readonly reason: string | null };
  readonly warnings: readonly string[];
}

function prepareRemember(ctx: Context, opts: RememberOpts): PreparedRemember {
  if (opts.project) assertCallerProject(opts.project);
  const requestedScope = rememberScope(ctx, opts);
  const vetted = vetSecrets(opts.content, opts.tags ?? [], opts.untrusted === true);
  const detection = opts.untrusted ? detectInstruction(vetted.content) : { flagged: false, reason: null };
  const entry = createMemory(vetted.content, {
    kind: opts.kind ?? 'distilled',
    scope: detection.flagged ? quarantineScopeFor(requestedScope) : requestedScope,
    owner: opts.owner ?? null,
    artifact_ref: opts.artifactRef ?? null,
    tags: opts.tags,
    tenantId: ctx.tenantId,
    baseHalfLifeDays: loadConfig(ctx.hippoRoot).defaultHalfLifeDays,
  });
  // Aliases only widen what a reader matches; a row has one origin. A personal row's '' follows its owner into every project.
  const origin = opts.personal ? '' : opts.project?.name;
  const stamped = origin !== undefined ? { ...entry, origin_project: origin } : entry;
  return { entry: stamped, requestedScope, detection, warnings: vetted.warnings };
}

function rememberResult(ctx: Context, prepared: PreparedRemember, written?: ConnectorWriteOutcome): RememberResult {
  const { entry, detection, warnings } = prepared;
  const result: RememberResult = { id: entry.id, kind: entry.kind, tenantId: ctx.tenantId };
  if (detection.flagged) result.quarantined = { reason: detection.reason ?? 'unknown' };
  if (warnings.length > 0) result.warnings = [...warnings];
  if (written?.outcome === 'duplicate') result.duplicate = { memoryId: written.memoryId };
  return result;
}

/** A flagged row's review record, which the store writes in the row's own transaction. */
function quarantineOf({ requestedScope, detection }: PreparedRemember): ConnectorWrite['quarantine'] {
  return detection.flagged ? { originalScope: requestedScope, reason: detection.reason ?? 'unknown' } : undefined;
}

/** Store one memory: the store's entryWrites group writes the row and its one remember audit row, under the caller's subject.
 *  A write that carries a connector event or untrusted content goes through connectorWrites, which commits its companion rows with it. */
export function remember<C extends Context>(ctx: C, opts: RememberOpts): StoreReply<C, RememberResult> {
  return onStore(ctx, (port) => {
    const entryWrites = port.entryWrites ?? notPorted(port, 'entryWrites');
    const prepared = prepareRemember(ctx, opts);
    // A store writes origin_project as given, so the served folder's fallback is stamped here.
    const write = { entry: stampOriginProject(ctx.hippoRoot, prepared.entry), actor: ctx.actor.subject };
    if (opts.untrusted !== true && opts.event === undefined) return andThen(entryWrites.writeEntry(write), () => rememberResult(ctx, prepared));
    const connectorWrites = port.connectorWrites ?? notPorted(port, 'connectorWrites');
    const written = connectorWrites.writeConnectorEntry({ ...write, event: opts.event, quarantine: quarantineOf(prepared) });
    return andThen(written, (outcome) => rememberResult(ctx, prepared, outcome));
  });
}
