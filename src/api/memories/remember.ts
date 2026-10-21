// Write path: remember stores one memory after secret vetting and, for untrusted content, the instruction check.

import type { ConnectorEvent, ConnectorWrite, ConnectorWriteOutcome } from '../../store/port.js';
import { detectInstruction, INSTRUCTION_LIKE_TAG } from '../instruction-detect.js';
import { quarantineScopeFor } from '../../domain/trust/quarantine.js';
import {
  createMemory,
  type ConfidenceLevel,
  type Layer,
  type MemoryEntry,
  type MemoryKind,
  type TraceOutcome,
} from '../../base/memory/memory.js';
import { computeSalience, type SalienceResult } from '../../base/memory/salience.js';
import { vetSecrets } from '../../base/util/secret-detect.js';
import { assertCallerProject } from '../../base/scope/project-identity.js';
import { BadRequestError, ForbiddenError } from '../../base/errors/api-errors.js';
import {
  assertClientScope,
  PERSONAL_OWNER_MAX,
  canReadScope,
  personalScopeOf,
  ScopeForbiddenError,
} from '../../base/scope/recall-scope.js';
import { isQuarantineScope } from '../../domain/trust/quarantine.js';
import type { Context } from '../types.js';
import { autoSleepAfterWrite } from '../sleep/auto-sleep.js';

/** Row fields the caller's own process decides, as the CLI does from its flags and its salience gate. */
export interface RememberLocal {
  layer?: Layer;
  pinned?: boolean;
  confidence?: ConfidenceLevel;
  source?: string;
  schemaFit?: number;
  traceOutcome?: TraceOutcome;
  sourceSessionId?: string | null;
  /** A salience gate's start-weak verdict: the row starts at `strength`, and its half-life is multiplied by
   * `halfLifeFactor`, never below one day. */
  weaken?: { readonly strength: number; readonly halfLifeFactor: number };
}

export interface RememberOptions {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  tags?: string[];
  /** The connector event this write answers. The store logs it in the memory's own transaction; an event logged before
   * stores nothing and answers `duplicate`. */
  event?: ConnectorEvent;
  /** Connector-ingested content an agent doesn't control; gates detectInstruction. CLI/HTTP/MCP never set this. */
  untrusted?: boolean;
  /** The caller's project: its name becomes the row's origin. Without it the store's fallback applies (NULL on a shared
   * store). */
  project?: { readonly name: string; readonly aliases?: readonly string[] };
  /** Store it in the caller's own personal scope, readable by its owner alone in every project; needs an owner on the
   * actor and no `scope`. */
  personal?: boolean;
  /** Never set from a request body: a route or tool that copied it would let a client pin a row or pick its layer and
   * source. */
  local?: RememberLocal;
}

/** A write that asks for the salience gate: one it judges not worth keeping answers `RememberSkipped` and stores
 * nothing, and a weak one starts weakened. A pinned write skips the gate. Without the field, nothing is gated. */
export interface GatedRememberOptions extends RememberOptions {
  salienceGate: boolean;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
  /** The row as written, so a caller can show it without reading it back. */
  halfLifeDays: number;
  tags: string[];
  /** Set only when untrusted content was flagged and quarantined instead of stored under its requested scope. */
  quarantined?: { reason: string };
  /** Set only when the content held secret material, which was redacted before storing. */
  warnings?: string[];
  /** Set only when the write's event was logged before: nothing was stored, so `id` names no row; `memoryId` is the id
   * the first write logged. */
  duplicate?: { memoryId: string | null };
  /** Set only when the salience gate started the row weakened. */
  startedWeak?: { reason: string; strength: number };
}

/** The salience gate dropped the write: nothing was stored or counted. */
export interface RememberSkipped {
  skipped: { reason: string; score: number };
}

/** The scope a write lands in: the caller's own personal scope when asked for, else the client's, which may not be a
 * personal or quarantine one and must be one the same actor could read (a private scope needs its grant). */
function rememberScope(ctx: Context, opts: RememberOptions): string | null {
  if (!opts.personal) {
    assertClientScope(opts.scope);
    const scope = opts.scope ?? null;
    // Only the quarantine step below stamps a quarantine scope, so no client request may name one.
    if (isQuarantineScope(scope) || (scope !== null && !canReadScope(ctx.actor, scope))) {
      throw new ScopeForbiddenError(scope!);
    }
    return scope;
  }
  if (opts.untrusted) throw new Error('personal memories come from their owner, never from a connector');
  if (opts.scope !== undefined) throw new BadRequestError('send personal or scope, not both');
  const own = personalScopeOf(ctx.actor);
  if (own === null) {
    throw new BadRequestError(
      `personal memories need a key its owner minted, or a sign-in; owner ids over ${PERSONAL_OWNER_MAX} characters or with control characters cannot hold them`,
    );
  }
  return own;
}

/** A row's owner is the person behind the caller's key; only an admin may write one for someone else. */
function assertOwnerIsCallers(ctx: Context, owner: string | undefined): void {
  if (owner === undefined || owner === ctx.actor.owner) return;
  if (ctx.actor.role === 'admin' || ctx.actor.hostAdmin) return;
  throw new ForbiddenError("owner must be the caller's own unless the caller is an admin");
}

/** The vetted row a remember writes, with its scope and quarantine verdict, decided the same way on both paths. */
interface PreparedRemember {
  readonly entry: MemoryEntry;
  readonly requestedScope: string | null;
  readonly detection: { readonly flagged: boolean; readonly reason: string | null };
  readonly warnings: readonly string[];
}

function prepareRemember(ctx: Context, opts: RememberOptions): PreparedRemember {
  if (opts.project) assertCallerProject(opts.project);
  assertOwnerIsCallers(ctx, opts.owner);
  const requestedScope = rememberScope(ctx, opts);
  const vetted = vetSecrets(opts.content);
  const detection = opts.untrusted ? detectInstruction(vetted.content) : { flagged: false, reason: null };
  const flagged = memberShares(ctx, opts) && detectInstruction(vetted.content).flagged;
  const tags = flagged ? [...(opts.tags ?? []), INSTRUCTION_LIKE_TAG] : opts.tags;
  const local = opts.local ?? {};
  const created = createMemory(vetted.content, {
    layer: local.layer,
    pinned: local.pinned,
    confidence: local.confidence,
    source: local.source,
    schemaFit: local.schemaFit,
    traceOutcome: local.traceOutcome,
    sourceSessionId: local.sourceSessionId,
    kind: opts.kind ?? 'distilled',
    scope: detection.flagged ? quarantineScopeFor(requestedScope) : requestedScope,
    owner: opts.owner ?? null,
    artifactRef: opts.artifactRef ?? null,
    tags,
    tenantId: ctx.tenantId,
    baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
  });
  const entry = local.weaken ? weakened(created, local.weaken) : created;
  // Aliases only widen what a reader matches; a row has one origin.
  // A personal row's '' follows its owner into every project.
  const origin = opts.personal ? '' : opts.project?.name;
  const stamped = origin !== undefined ? { ...entry, originProject: origin } : entry;
  return { entry: stamped, requestedScope, detection, warnings: vetted.warnings };
}

/** A member key's write outside its personal scope reaches the other members' prompts, as connector text does. */
function memberShares(ctx: Context, opts: RememberOptions): boolean {
  return ctx.actor.role === 'member' && !opts.personal && !opts.untrusted;
}

function weakened(entry: MemoryEntry, weaken: NonNullable<RememberLocal['weaken']>): MemoryEntry {
  return {
    ...entry,
    strength: weaken.strength,
    halfLifeDays: Math.max(1, entry.halfLifeDays * weaken.halfLifeFactor),
  };
}

function rememberResult(ctx: Context, prepared: PreparedRemember, written?: ConnectorWriteOutcome): RememberResult {
  const { entry, detection, warnings } = prepared;
  const result: RememberResult = {
    id: entry.id,
    kind: entry.kind,
    tenantId: ctx.tenantId,
    halfLifeDays: entry.halfLifeDays,
    tags: [...entry.tags],
  };
  if (detection.flagged) result.quarantined = { reason: detection.reason ?? 'unknown' };
  if (warnings.length > 0) result.warnings = [...warnings];
  if (written?.outcome === 'duplicate') result.duplicate = { memoryId: written.memoryId };
  return result;
}

/** A flagged row's review record, which the store writes in the row's own transaction. */
function quarantineOf({ requestedScope, detection }: PreparedRemember): ConnectorWrite['quarantine'] {
  return detection.flagged ? { originalScope: requestedScope, reason: detection.reason ?? 'unknown' } : undefined;
}

// The newest rows the gate compares against, whatever `recentWindow` says: a window below 1 once meant the whole
// tenant, and a window past this reads more than a duplicate check needs.
const MAX_SALIENCE_ROWS = 500;
const WEAK_HALF_LIFE_FACTOR = 0.5;

/** The gate's verdict on one write, or null where it does not judge: the store has it off, or the write is pinned. */
async function salienceVerdict(ctx: Context, opts: RememberOptions): Promise<SalienceResult | null> {
  const { salience } = ctx.config;
  if (!salience.enabled || opts.local?.pinned) return null;
  // computeSalience compares against the last `recentWindow` rows only.
  const window = Math.trunc(salience.recentWindow);
  const rows = Number.isSafeInteger(window) && window >= 1 ? Math.min(window, MAX_SALIENCE_ROWS) : MAX_SALIENCE_ROWS;
  const recent = await ctx.store.contextReads.newestEntries(ctx.tenantId, rows);
  return computeSalience(opts.content, [...(opts.tags ?? [])], recent, {
    recentWindow: salience.recentWindow,
    overlapThreshold: salience.overlapThreshold,
    minContentLength: salience.minContentLength,
    maxRepeatErrors: salience.maxRepeatErrors,
  });
}

/** Store one memory, then start the root's auto-sleep if enough new memories have landed (`ctx.callers`). With
 * `salienceGate` the write may be dropped instead (see GatedRememberOptions). */
export async function remember(ctx: Context, opts: GatedRememberOptions): Promise<RememberResult | RememberSkipped>;
export async function remember(ctx: Context, opts: RememberOptions): Promise<RememberResult>;
export async function remember(
  ctx: Context,
  opts: RememberOptions | GatedRememberOptions,
): Promise<RememberResult | RememberSkipped> {
  const verdict = 'salienceGate' in opts && opts.salienceGate ? await salienceVerdict(ctx, opts) : null;
  if (verdict?.decision === 'skip') return { skipped: { reason: verdict.reason, score: verdict.score } };
  const startedWeak =
    verdict?.decision === 'start_weak' ? { reason: verdict.reason, strength: verdict.score } : undefined;
  const local = startedWeak
    ? { ...opts.local, weaken: { strength: startedWeak.strength, halfLifeFactor: WEAK_HALF_LIFE_FACTOR } }
    : opts.local;
  const result = await writeRemembered(ctx, { ...opts, local });
  await autoSleepAfterWrite(ctx);
  return startedWeak ? { ...result, startedWeak } : result;
}

/** The store's entryWrites group writes the row and its one remember audit row, under the caller's subject. A write
 * that carries a connector event or untrusted content goes through connectorWrites, which commits its companion rows
 * with it. */
async function writeRemembered(ctx: Context, opts: RememberOptions): Promise<RememberResult> {
  const store = ctx.store;
  const entryWrites = store.entryWrites;
  const prepared = prepareRemember(ctx, opts);
  const write = { entry: prepared.entry, actor: ctx.actor.subject };
  if (opts.untrusted !== true && opts.event === undefined) {
    await entryWrites.writeEntry(write);
    return rememberResult(ctx, prepared);
  }
  const written = await store.connectorWrites.writeConnectorEntry({
    ...write,
    event: opts.event,
    quarantine: quarantineOf(prepared),
  });
  return rememberResult(ctx, prepared, written);
}
