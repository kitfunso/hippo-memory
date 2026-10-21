// The write verbs: `hippo remember`, `hippo supersede` and `hippo trace`.

import { envActiveScope } from '../../base/util/env.js';
import { conflictToWire } from '../../base/memory/conflict-wire.js';
import * as fs from 'fs';
import { Layer, ConfidenceLevel, strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import * as api from '../../api/index.js';
import { memoryGet, memoryListByIds } from '../../api/memories/memories.js';
import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import { isInitialized, resolveGlobalRootDir } from '../../base/scope/project-identity.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { parseSteps, traceRecord, traceStats } from '../../api/memories/trace.js';
import { extractPathTags } from '../../api/memories/remember-local.js';
import { assertClientScope } from '../../base/scope/recall-scope.js';
import * as client from './client.js';
import { cliApiContext, cliConfig, cliInitGlobal } from './api-context.js';
import { validateOwner, isStrictOwnerEnv } from './owner-validation.js';
import { printError } from './output.js';
import { requireInit, runViaServerIfAvailable } from './shared.js';
import { fmt } from './print.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  hasFlag,
  isOneOf,
  repeatedFlag,
  stringFlag,
  stringFlagOrExit,
  stringListFlag,
} from './flag-values.js';
import { errorMessage } from '../../base/util/log.js';
import { CliExit, fail } from './exit.js';

const PARENT_PREVIEW_CHARS = 70;
const DETAIL_CONTENT_CHARS = 160;

// `requested` is what the caller typed; `all` adds path and scope tags from this process's cwd and env.
interface RememberTags {
  requested: string[];
  all: string[];
}

// Shared by the direct write and the routed request so both store the same tags.
function rememberTags(flags: CliFlags, cwd: string): RememberTags {
  const requested = [...repeatedFlag(flags, 'tag')];
  if (boolFlag(flags, 'error')) requested.push('error');
  const all = [...requested];
  for (const pt of extractPathTags(cwd)) {
    if (!all.includes(pt)) all.push(pt);
  }
  const explicitScope = stringFlagOrExit(flags, 'scope') ?? null;
  const activeScope = explicitScope || envActiveScope();
  if (activeScope) {
    const scopeTag = `scope:${activeScope}`;
    if (!all.includes(scopeTag)) all.push(scopeTag);
  }
  return { requested, all };
}

function rememberConfidence(flags: CliFlags): ConfidenceLevel {
  let confidence: ConfidenceLevel = 'verified';
  if (boolFlag(flags, 'observed')) confidence = 'observed';
  if (boolFlag(flags, 'inferred')) confidence = 'inferred';
  if (boolFlag(flags, 'verified')) confidence = 'verified';
  return confidence;
}

const USER_VISIBLE_KINDS = ['distilled', 'superseded'] as const;
type UserVisibleKind = (typeof USER_VISIBLE_KINDS)[number];

function parseKindFlag(flags: CliFlags): UserVisibleKind | undefined {
  const kindFlagRaw = stringFlag(flags, 'kind');
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // 'raw' is reserved for ingestion connectors (deletions go through archiveRawMemory); the append-only trigger aborts
  // forget/consolidate on raw rows, so exposing --kind raw would create unforgettable memories. 'archived' is an
  // internal sentinel set only in that transaction.
  if (kindFlag !== undefined && !isOneOf(USER_VISIBLE_KINDS, kindFlag)) {
    printError(`Invalid --kind: "${kindFlagRaw}". Must be one of: ${USER_VISIBLE_KINDS.join(', ')}`);
    fail(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
  }
  return kindFlag;
}

interface RememberEnvelope {
  kind: UserVisibleKind | undefined;
  owner: string | null;
  artifactRef: string | null;
  scope: string | null;
}

function parseRememberEnvelope(flags: CliFlags): RememberEnvelope {
  const kind = parseKindFlag(flags);
  const ownerRaw = stringFlag(flags, 'owner') ?? null;
  const ownerCheck = validateOwner(ownerRaw, { strict: isStrictOwnerEnv() });
  if (!ownerCheck.ok) {
    fail(ownerCheck.message);
  }
  if (ownerCheck.message) printError(ownerCheck.message);
  const owner = ownerCheck.value ?? null;
  const artifactRef = stringFlag(flags, 'artifact-ref') ?? null;
  const scope = stringFlag(flags, 'scope')?.trim() || null;
  assertClientScope(scope);
  return { kind, owner, artifactRef, scope };
}

async function writeMemory(hippoRoot: string, tenantId: string, text: string, flags: CliFlags): Promise<void> {
  const useGlobal = boolFlag(flags, 'global');
  const targetRoot = useGlobal ? resolveGlobalRootDir() : hippoRoot;

  if (useGlobal) {
    cliInitGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const { requested: requestedTags, all: allTags } = rememberTags(flags, process.cwd());
  const envelope = parseRememberEnvelope(flags);

  const ctx = cliApiContext(targetRoot, tenantId);
  const outcome = await api.rememberLocally(ctx, {
    content: text,
    kind: envelope.kind,
    scope: envelope.scope ?? undefined,
    owner: envelope.owner ?? undefined,
    artifactRef: envelope.artifactRef ?? undefined,
    tags: allTags,
    // Schema fit is scored on the tags the caller typed, without the path and scope tags added from this process.
    fitTags: requestedTags,
    layer: Layer.Episodic,
    pinned: boolFlag(flags, 'pin'),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence: rememberConfidence(flags),
    force: boolFlag(flags, 'force'),
  });
  if (outcome.status === 'skipped') {
    printSkipped(outcome);
    return;
  }
  if (outcome.startedWeak) printWeakened(outcome.startedWeak);
  printRemembered(outcome.entry, useGlobal, outcome.warnings);

  const request = { requested: boolFlag(flags, 'extract') };
  printExtraction(await api.extractRememberedFacts(ctx, outcome.entry, request));
}

function printSkipped({ reason, score }: { reason: string; score: number }): void {
  console.log(`Skipped (salience: ${reason}, score ${score.toFixed(2)})`);
}

function printWeakened({ reason, strength }: { reason: string; strength: number }): void {
  console.log(`Weakened (salience: ${reason}, strength ${strength.toFixed(2)})`);
}

function printRemembered(entry: MemoryEntry, useGlobal: boolean, warnings: readonly string[]): void {
  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(
    `   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.halfLifeDays}d | ` +
      `Confidence: ${entry.confidence}`,
  );
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');
  for (const w of warnings) printError(`Warning: ${w}`);
}

function printExtraction(extraction: api.FactExtraction): void {
  if (extraction.status === 'no_key') printError('  (extraction skipped: ANTHROPIC_API_KEY not set)');
  if (extraction.status !== 'ran') return;
  for (const failure of extraction.failures) printError(`  (extraction failed: ${failure})`);
  if (extraction.facts > 0) printError(`  extracted ${extraction.facts} fact(s)`);
}

function supersedeTags(flags: CliFlags): string[] | undefined {
  return stringListFlag(flags, 'tag');
}

/** The api's conflict text differs by which writer lost; the row itself names its successor either way. */
async function alreadySupersededLine(
  hippoRoot: string,
  oldId: string,
  tenantId: string,
  conflict: ConflictError,
): Promise<string> {
  const by = (await memoryGet(cliApiContext(hippoRoot, tenantId), oldId))?.supersededBy;
  return by
    ? `Error: memory ${oldId} is already superseded by ${by}. Supersede that one instead.`
    : `Error: ${conflict.message}`;
}

function parseLayerFlag(flags: CliFlags): Layer | undefined {
  const raw = stringFlag(flags, 'layer');
  if (raw === undefined) return undefined;
  const layer = Object.values(Layer).find((l) => l === raw);
  if (layer === undefined) {
    fail(`Invalid --layer: "${raw}". Must be one of: ${Object.values(Layer).join(', ')}`);
  }
  return layer;
}

async function supersedeMemory(
  hippoRoot: string,
  tenantId: string,
  oldId: string,
  newContent: string,
  flags: CliFlags,
): Promise<void> {
  requireInit(hippoRoot);

  const overrides = {
    layer: parseLayerFlag(flags),
    tags: supersedeTags(flags),
    // Without --pin the successor keeps the old row's pin.
    pinned: boolFlag(flags, 'pin') ? true : undefined,
  };

  let newId: string;
  try {
    ({ newId } = await api.supersede(cliApiContext(hippoRoot, tenantId), oldId, newContent, overrides));
  } catch (err) {
    if (err instanceof NotFoundError) printError(`Error: memory ${oldId} not found.`);
    else if (err instanceof RejectedValueError) printError(`Error: ${err.message}`);
    else if (err instanceof ConflictError) printError(await alreadySupersededLine(hippoRoot, oldId, tenantId, err));
    else throw err;
    throw new CliExit(1);
  }
  console.log(`Superseded ${oldId} → ${newId}`);
}

function parseStepsOrExit(stepsJson: string): ReturnType<typeof parseSteps> {
  try {
    return parseSteps(stepsJson);
  } catch (err) {
    fail(errorMessage(err));
  }
}

function traceTags(flags: CliFlags): string[] {
  return stringListFlag(flags, 'tag') ?? [];
}

async function recordTrace(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  requireInit(hippoRoot);

  const task = stringFlagOrExit(flags, 'task') ?? '';
  const stepsJson = stringFlagOrExit(flags, 'steps') ?? '';
  const outcome = stringFlagOrExit(flags, 'outcome') ?? '';
  const validOutcomes = ['success', 'failure', 'partial'] as const;

  if (!task || !stepsJson || !outcome) {
    fail(
      'Usage: hippo trace record --task <t> --steps <json> --outcome <success|failure|partial> ' +
        '[--session <id>] [--tag <t>]',
    );
  }
  if (!isOneOf(validOutcomes, outcome)) {
    fail(`Invalid outcome: "${outcome}". Must be one of: ${validOutcomes.join(', ')}.`);
  }

  const steps = parseStepsOrExit(stepsJson);

  const sessionId = stringFlagOrExit(flags, 'session') || null;
  const tags = traceTags(flags);

  const { id } = await traceRecord(cliApiContext(hippoRoot, tenantId), {
    task,
    steps,
    outcome,
    sessionId,
    tags,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
  });

  console.log(`Recorded trace ${id} (outcome=${outcome}, ${steps.length} steps)`);
}

async function printTrace(hippoRoot: string, tenantId: string, id: string, flags: CliFlags): Promise<void> {
  requireInit(hippoRoot);
  const asJson = boolFlag(flags, 'json');

  // Look in local store first, then global.
  let entry = await memoryGet(cliApiContext(hippoRoot, tenantId), id);
  let sourceLabel: 'local' | 'global' = 'local';
  const globalRoot = resolveGlobalRootDir();
  if (!entry && isInitialized(globalRoot)) {
    entry = await memoryGet(cliApiContext(globalRoot, tenantId), id);
    sourceLabel = 'global';
  }
  if (!entry) {
    fail(`Memory not found: ${id}`);
  }

  const t: TraceView = {
    entry,
    id,
    sourceLabel,
    ...traceStats(entry, strengthOptionsOf(cliConfig(hippoRoot).runtime)),
    ...(await traceLineage(hippoRoot, globalRoot, entry, id, tenantId)),
  };
  if (asJson) {
    printTraceJson(t);
    return;
  }
  printTraceText(t);
}

type TraceView = ReturnType<typeof traceStats> &
  Awaited<ReturnType<typeof traceLineage>> & {
    entry: MemoryEntry;
    id: string;
    sourceLabel: 'local' | 'global';
  };

async function traceLineage(hippoRoot: string, globalRoot: string, entry: MemoryEntry, id: string, tenantId: string) {
  // Parents (consolidation lineage) — schema v9 field.
  const parents = Array.isArray(entry.parents) ? entry.parents : [];
  const local = parents.length === 0 ? [] : await memoryListByIds(cliApiContext(hippoRoot, tenantId), parents);
  const found = new Map(local.map((p) => [p.id, p]));
  const missing = parents.filter((pid) => !found.has(pid));
  if (missing.length > 0 && isInitialized(globalRoot)) {
    for (const p of await memoryListByIds(cliApiContext(globalRoot, tenantId), missing)) found.set(p.id, p);
  }
  const parentPreviews = parents.map((pid) => {
    const p = found.get(pid);
    return { id: pid, content: p ? p.content.replace(/\s+/g, ' ').slice(0, PARENT_PREVIEW_CHARS) : '(not found)' };
  });

  const openIn = (root: string) =>
    api.conflictListAll((page) => api.conflictList(cliApiContext(root, tenantId), 'open', {}, page));
  const allConflicts = [...(await openIn(hippoRoot)), ...(isInitialized(globalRoot) ? await openIn(globalRoot) : [])];
  const myConflicts = allConflicts.filter((c) => c.memoryAId === id || c.memoryBId === id);
  return { parentPreviews, myConflicts };
}

function printTraceJson(t: TraceView): void {
  const { entry, facets } = t;
  console.log(
    JSON.stringify(
      {
        id: entry.id,
        source: t.sourceLabel,
        layer: entry.layer,
        confidence: facets.tier,
        aged_out: facets.agedOut,
        pinned: entry.pinned,
        starred: entry.starred,
        tags: entry.tags,
        content: entry.content,
        created: entry.created,
        age_days: t.ageDays,
        last_retrieved: entry.lastRetrieved,
        days_since_last_retrieval: t.sinceLast,
        retrieval_count: entry.retrievalCount,
        strength_now: t.strength,
        half_life_days: t.halfLife,
        reward_factor: t.rewardFactor,
        effective_half_life_days: t.effHalfLife,
        projected_strength_30d: t.projectedAt(30),
        projected_strength_90d: t.projectedAt(90),
        outcome_positive: entry.outcomePositive,
        outcome_negative: entry.outcomeNegative,
        parents: t.parentPreviews,
        open_conflicts: t.myConflicts.map(conflictToWire),
      },
      null,
      2,
    ),
  );
}

function printTraceText(t: TraceView): void {
  const { entry, id, sourceLabel, conf, ageDays, strength, projectedAt } = t;
  const { halfLife, rewardFactor, effHalfLife, sinceLast } = t;
  const { parentPreviews, myConflicts } = t;
  console.log(`Memory: ${entry.id}  [${sourceLabel}]`);
  console.log('='.repeat(50));
  const ellipsis = entry.content.length > DETAIL_CONTENT_CHARS ? '...' : '';
  console.log(`Content:   ${entry.content.replace(/\s+/g, ' ').slice(0, DETAIL_CONTENT_CHARS)}${ellipsis}`);
  const starred = entry.starred ? '  Starred: ' + 'yes' : '';
  const pinned = entry.pinned ? 'yes' : 'no';
  console.log(`Layer:     ${entry.layer.padEnd(10)} Confidence: ${conf.padEnd(14)} Pinned: ${pinned}${starred}`);
  console.log(`Tags:      ${entry.tags.join(', ') || '(none)'}`);
  console.log(`Created:   ${entry.created}  (${fmt(ageDays, 1)} days ago)`);
  console.log();
  console.log(`Strength trajectory:`);
  console.log(`  now:        ${fmt(strength, 3)}`);
  console.log(`  in 30 days: ${fmt(projectedAt(30), 3)}`);
  console.log(`  in 90 days: ${fmt(projectedAt(90), 3)}`);
  console.log(
    `  half-life:  ${fmt(halfLife, 1)}d (stored) x ${fmt(rewardFactor, 2)} reward = ${fmt(effHalfLife, 1)}d effective`,
  );
  console.log();
  console.log(`Retrieval:`);
  console.log(`  count:      ${entry.retrievalCount}`);
  console.log(`  last:       ${entry.lastRetrieved}  (${fmt(sinceLast, 1)} days ago)`);
  console.log();
  console.log(`Outcomes:   +${entry.outcomePositive} / -${entry.outcomeNegative}`);
  if (parentPreviews.length > 0) {
    console.log();
    console.log(`Parents (consolidation lineage):`);
    for (const p of parentPreviews) {
      console.log(`  - ${p.id}: ${p.content}`);
    }
  }
  if (myConflicts.length > 0) {
    console.log();
    console.log(`Open conflicts: ${myConflicts.length}`);
    for (const c of myConflicts) {
      const other = c.memoryAId === id ? c.memoryBId : c.memoryAId;
      console.log(`  - with ${other}: ${c.reason} (score=${fmt(c.score, 2)})`);
    }
  }
}

export async function handleRemember({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  let text: string;
  if (args.length === 1 && args[0] === '-') {
    text = fs.readFileSync(0, 'utf-8').trim();
  } else {
    text = args.join(' ').trim();
  }
  if (!text || text.length < 3) {
    fail('Memory content too short (minimum 3 characters).');
  }
  // Thin-client routing: simple `remember` calls go over HTTP so the daemon stays the single writer; rich flags need
  // the direct path. Both paths ask the api for the same salience gate.
  const richFlag =
    boolFlag(flags, 'pin') ||
    boolFlag(flags, 'global') ||
    boolFlag(flags, 'extract') ||
    boolFlag(flags, 'force') ||
    boolFlag(flags, 'observed') ||
    boolFlag(flags, 'inferred') ||
    boolFlag(flags, 'verified') ||
    hasFlag(flags, 'layer');
  if (!richFlag && (await rememberViaThinClient(hippoRoot, text, flags))) return;
  await writeMemory(hippoRoot, tenantId, text, flags);
}

async function rememberViaThinClient(hippoRoot: string, text: string, flags: CliFlags): Promise<boolean> {
  const rememberKindRaw = stringFlag(flags, 'kind')?.toLowerCase();
  if (rememberKindRaw !== undefined && !isOneOf(USER_VISIBLE_KINDS, rememberKindRaw)) return false;
  const tags = rememberTags(flags, process.cwd()).all;
  // Validate --owner on the thin-client path too, so validation is the same whether or not a server is up.
  const thinOwnerRaw = stringFlag(flags, 'owner');
  const thinOwnerCheck = validateOwner(thinOwnerRaw, { strict: isStrictOwnerEnv() });
  if (!thinOwnerCheck.ok) {
    fail(thinOwnerCheck.message);
  }
  if (thinOwnerCheck.message) printError(thinOwnerCheck.message);
  return runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
    const result = await client.remember(info.url, apiKey, {
      content: text,
      kind: rememberKindRaw,
      scope: stringFlag(flags, 'scope'),
      owner: thinOwnerCheck.value,
      artifactRef: stringFlag(flags, 'artifact-ref'),
      tags,
    });
    if ('skipped' in result) {
      printSkipped(result.skipped);
      return;
    }
    const weak = result.startedWeak;
    if (weak) printWeakened(weak);
    console.log(`Remembered [${result.id}] (via ${info.url})`);
    console.log(`   Kind: ${result.kind} | Tenant: ${result.tenantId}`);
    for (const w of result.warnings ?? []) printError(`Warning: ${w}`);
  });
}

export async function handleSupersede({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const oldId = args[0];
  const newContent = args.slice(1).join(' ').trim();
  if (!oldId || !newContent) {
    fail('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
  }
  await supersedeMemory(hippoRoot, tenantId, oldId, newContent, flags);
}

export async function handleTrace({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sub = args[0] ? String(args[0]) : '';
  if (sub === 'record') {
    await recordTrace(hippoRoot, tenantId, flags);
    return;
  }
  if (!sub) {
    fail('Usage: hippo trace <memory-id> | hippo trace record --task <t> --steps <json> --outcome <o>');
  }
  await printTrace(hippoRoot, tenantId, sub, flags);
}
