import type {
  ConnectorEvent,
  ConnectorWrite,
  ConnectorWriteOutcome,
} from '../../base/ports/store.js';
import {
  createMemory,
  type ConfidenceLevel,
  type Layer,
  type MemoryEntry,
  type MemoryKind,
  type TraceOutcome,
  withoutCaptureTags,
} from '../../base/memory/entry.js';
import { computeSalience, type SalienceResult } from '../../base/memory/salience.js';
import { MAX_LEAD_IN_CHARS } from '../../base/util/limits.js';
import { identityText } from '../../base/util/same-text.js';
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
import type { Context, ContextWith } from '../types.js';
import { autoSleepAfterWrite } from '../sleep/auto-sleep.js';
import { markedTags, reviewerOf, screenWrite, type ReviewGroup } from './write-screen.js';
import { admitProjectWrite } from '../project-write-gate.js';

/** Row fields the caller's own process decides, as the CLI does from its flags and its salience
 * gate. */
export interface RememberLocal {
  layer?: Layer;
  pinned?: boolean;
  confidence?: ConfidenceLevel;
  source?: string;
  schemaFit?: number;
  traceOutcome?: TraceOutcome;
  sourceSessionId?: string | null;
  weaken?: { readonly strength: number; readonly halfLifeFactor: number };
}

export interface RememberOptions {
  content: string;
  kind?: MemoryKind;
  scope?: string;
  owner?: string;
  artifactRef?: string;
  leadIn?: string;
  tags?: string[];
  project?: { readonly name: string; readonly aliases?: readonly string[] };
  personal?: boolean;
  local?: RememberLocal;
}

/** A connector's write of content an agent doesn't control. */
export interface ConnectorRememberOptions extends RememberOptions {
  event?: ConnectorEvent;
  hold?: { readonly reason: string };
}

/** A write that asks for the salience gate: one it judges not worth keeping answers
 * `RememberSkipped` and stores nothing, and a weak one starts weakened. A pinned write skips the
 * gate. Without the field, nothing is gated. */
export interface GatedRememberOptions extends RememberOptions {
  salienceGate: boolean;
}

export interface RememberResult {
  id: string;
  kind: MemoryKind;
  tenantId: string;
  halfLifeDays: number;
  tags: string[];
  quarantined?: { reason: string };
  warnings?: string[];
  duplicate?: { memoryId: string | null };
  startedWeak?: { reason: string; strength: number };
}

/** The salience gate dropped the write: nothing was stored or counted. */
export interface RememberSkipped {
  skipped: { reason: string; score: number };
}

function rememberScope(ctx: Context, opts: RememberOptions, untrusted: boolean): string | null {
  if (!opts.personal) {
    assertClientScope(opts.scope);
    const scope = opts.scope ?? null;
    if (isQuarantineScope(scope) || (scope !== null && !canReadScope(ctx.actor, scope))) {
      throw new ScopeForbiddenError(scope!);
    }
    return scope;
  }
  if (untrusted) {
    throw new Error('personal memories come from their owner, never from a connector');
  }
  if (opts.scope !== undefined) throw new BadRequestError('send personal or scope, not both');
  const own = personalScopeOf(ctx.actor);
  if (own === null) {
    throw new BadRequestError(
      `personal memories need a key its owner minted, or a sign-in; owner ids over ${PERSONAL_OWNER_MAX} characters or with control characters cannot hold them`,
    );
  }
  return own;
}

function assertOwnerIsCallers(ctx: Context, owner: string | undefined): void {
  if (owner === undefined || owner === ctx.actor.owner) return;
  if (ctx.actor.role === 'admin' || ctx.actor.hostAdmin) return;
  throw new ForbiddenError("owner must be the caller's own unless the caller is an admin");
}

interface PreparedRemember {
  readonly entry: MemoryEntry;
  readonly quarantine: ConnectorWrite['quarantine'];
  readonly warnings: readonly string[];
}

interface NormalizedLeadIn {
  readonly leadIn: string | null;
  readonly warnings: readonly string[];
}

function normalizeLeadIn(raw: string | null | undefined): NormalizedLeadIn {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return { leadIn: null, warnings: [] };
  const vetted = vetSecrets(trimmed);
  const warnings = vetted.warnings.map((w) => `lead-in: ${w}`);
  if (vetted.content.length <= MAX_LEAD_IN_CHARS) return { leadIn: vetted.content, warnings };
  warnings.push(`lead-in: cut to its last ${MAX_LEAD_IN_CHARS} characters`);
  return { leadIn: lastChars(vetted.content, MAX_LEAD_IN_CHARS), warnings };
}

function lastChars(text: string, count: number): string {
  const tail = text.slice(-count);
  return (/^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail).trim();
}

function prepareRemember(
  ctx: Context,
  opts: ConnectorRememberOptions,
  screen: { readonly untrusted: boolean; readonly holds: boolean },
): PreparedRemember {
  if (opts.project) assertCallerProject(opts.project);
  assertOwnerIsCallers(ctx, opts.owner);
  const requestedScope = rememberScope(ctx, opts, screen.untrusted);
  const vetted = vetSecrets(opts.content);
  const lead = normalizeLeadIn(opts.leadIn);
  const tags = opts.tags && withoutCaptureTags(opts.tags);
  const verdict = screenWrite(ctx.actor, {
    text: { content: vetted.content, leadIn: lead.leadIn },
    tags,
    scope: requestedScope,
    untrusted: screen.untrusted,
    rule: opts.hold,
    holds: screen.holds,
  });
  const rowTags = markedTags(tags, verdict.marks);
  const local = opts.local ?? {};
  const created = createMemory(
    vetted.content,
    {
      layer: local.layer,
      pinned: local.pinned,
      confidence: local.confidence,
      source: local.source,
      schemaFit: local.schemaFit,
      traceOutcome: local.traceOutcome,
      sourceSessionId: local.sourceSessionId,
      kind: opts.kind ?? 'distilled',
      scope: verdict.scope,
      owner: opts.owner ?? null,
      artifactRef: opts.artifactRef ?? null,
      leadIn: lead.leadIn,
      tags: rowTags,
      tenantId: ctx.tenantId,
      baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
    },
    ctx.infra.clock(),
  );
  return {
    entry: withOrigin(local.weaken ? weakened(created, local.weaken) : created, opts),
    quarantine: verdict.quarantine,
    warnings: [...vetted.warnings, ...lead.warnings],
  };
}

function withOrigin(entry: MemoryEntry, opts: RememberOptions): MemoryEntry {
  const origin = opts.personal ? '' : opts.project?.name;
  return origin !== undefined ? { ...entry, originProject: origin } : entry;
}

function weakened(entry: MemoryEntry, weaken: NonNullable<RememberLocal['weaken']>): MemoryEntry {
  return {
    ...entry,
    strength: weaken.strength,
    halfLifeDays: Math.max(1, entry.halfLifeDays * weaken.halfLifeFactor),
  };
}

function rememberResult(
  ctx: Context,
  prepared: PreparedRemember,
  written?: ConnectorWriteOutcome,
): RememberResult {
  const { entry, quarantine, warnings } = prepared;
  const result: RememberResult = {
    id: entry.id,
    kind: entry.kind,
    tenantId: ctx.tenantId,
    halfLifeDays: entry.halfLifeDays,
    tags: [...entry.tags],
  };
  if (quarantine) result.quarantined = { reason: quarantine.reason };
  if (warnings.length > 0) result.warnings = [...warnings];
  if (written?.outcome === 'duplicate') result.duplicate = { memoryId: written.memoryId };
  return result;
}

const MAX_SALIENCE_ROWS = 500;
const WEAK_HALF_LIFE_FACTOR = 0.5;

async function salienceVerdict(
  ctx: Context,
  opts: RememberOptions,
): Promise<SalienceResult | null> {
  const { salience } = ctx.config;
  if (!salience.enabled || opts.local?.pinned) return null;
  const window = Math.trunc(salience.recentWindow);
  const rows =
    Number.isSafeInteger(window) && window >= 1
      ? Math.min(window, MAX_SALIENCE_ROWS)
      : MAX_SALIENCE_ROWS;
  const newest = await ctx.store.entriesWhere(
    { tenantId: ctx.tenantId },
    { limit: rows, newest: true },
  );
  const live = newest.entries.filter((e) => !isQuarantineScope(e.scope ?? null));
  const leadIn = normalizeLeadIn(opts.leadIn).leadIn;
  const text = identityText({ content: opts.content, leadIn });
  return computeSalience(text, [...(opts.tags ?? [])], live.reverse(), {
    recentWindow: salience.recentWindow,
    overlapThreshold: salience.overlapThreshold,
    minContentLength: salience.minContentLength,
    maxRepeatErrors: salience.maxRepeatErrors,
  });
}

/** Store one memory, then start the root's auto-sleep if enough new memories have landed
 * (`ctx.callers`). With `salienceGate` the write may be dropped instead (see
 * GatedRememberOptions). */
export async function remember(
  ctx: Context,
  opts: GatedRememberOptions,
): Promise<RememberResult | RememberSkipped>;
export async function remember(ctx: Context, opts: RememberOptions): Promise<RememberResult>;
export async function remember(
  ctx: Context,
  opts: RememberOptions | GatedRememberOptions,
): Promise<RememberResult | RememberSkipped> {
  if (!opts.personal) await admitProjectWrite(ctx, opts.project ?? null);
  const verdict =
    'salienceGate' in opts && opts.salienceGate ? await salienceVerdict(ctx, opts) : null;
  if (verdict?.decision === 'skip') {
    return { skipped: { reason: verdict.reason, score: verdict.score } };
  }
  const startedWeak =
    verdict?.decision === 'start_weak'
      ? { reason: verdict.reason, strength: verdict.score }
      : undefined;
  const local = startedWeak
    ? {
        ...opts.local,
        weaken: { strength: startedWeak.strength, halfLifeFactor: WEAK_HALF_LIFE_FACTOR },
      }
    : opts.local;
  const result = await writeRemembered(ctx, { ...opts, local });
  await autoSleepAfterWrite(ctx);
  return startedWeak ? { ...result, startedWeak } : result;
}

async function writeRemembered(
  ctx: ContextWith<never, ReviewGroup>,
  opts: RememberOptions,
): Promise<RememberResult> {
  const reviewer = reviewerOf(ctx);
  const prepared = prepareRemember(ctx, opts, { untrusted: false, holds: reviewer !== undefined });
  const write = { entry: prepared.entry, actor: ctx.actor.subject };
  if (reviewer && prepared.quarantine) {
    await reviewer.writeConnectorEntry({ ...write, quarantine: prepared.quarantine });
  } else {
    await ctx.store.entryWrites.writeEntry(write);
  }
  return rememberResult(ctx, prepared);
}

/** Store one row of connector content, which the instruction check gates. connectorWrites
 * commits the row with its event and any quarantine record, so an event logged before stores
 * nothing and answers `duplicate`. */
export async function rememberUntrusted(
  ctx: ContextWith<'connectorWrites'>,
  opts: ConnectorRememberOptions,
): Promise<RememberResult> {
  const prepared = prepareRemember(ctx, opts, { untrusted: true, holds: true });
  const written = await ctx.store.connectorWrites.writeConnectorEntry({
    entry: prepared.entry,
    actor: ctx.actor.subject,
    event: opts.event,
    quarantine: prepared.quarantine,
  });
  await autoSleepAfterWrite(ctx);
  return rememberResult(ctx, prepared, written);
}
