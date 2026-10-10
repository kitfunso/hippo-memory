// The write verbs: `hippo remember`, `hippo supersede` and `hippo trace`.

import { envAnthropicApiKey } from '../util/env.js';
import { evalNow } from '../core/ablation.js';
import * as fs from 'fs';
import {
  calculateStrength,
  calculateRewardFactor,
  confidenceFacets,
  confidenceLabel,
  Layer,
  ConfidenceLevel,
  type MemoryEntry,
} from '../core/memory.js';
import * as api from '../api/index.js';
import { getMemory } from '../api/memories.js';
import { ConflictError, NotFoundError } from '../core/api-errors.js';
import { isInitialized } from '../store/open.js';
import { listMemoryConflicts } from '../store/conflicts.js';
import { RejectedValueError } from '../store/rejection.js';
import { renderTraceContent, parseSteps } from '../consolidate/trace.js';
import { extractPathTags } from '../search/path-context.js';
import { detectScope } from '../sharing/scope.js';
import { assertClientScope } from '../store/recall-scope.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { vetSecrets } from '../util/secret-detect.js';
import * as client from './client.js';
import { cliApiContext } from './api-context.js';
import { validateOwner, isStrictOwnerEnv } from './owner-validation.js';
import { printError } from './output.js';
import { requireInit, runViaServerIfAvailable } from './shared.js';
import { fmt } from './print.js';
import { type CliFlags, type CommandContext, boolFlag, flagIsTrue, isOneOf, stringFlag, stringListFlag } from './flag-values.js';
import { DAY_MS } from '../util/time.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

const PARENT_PREVIEW_CHARS = 70;
const DETAIL_CONTENT_CHARS = 160;

// `requested` is what the caller typed; `all` adds path and scope tags from this process's cwd and env.
interface RememberTags {
  requested: string[];
  all: string[];
}

// Shared by the direct write and the routed request so both store the same tags.
function rememberTags(
  flags: CliFlags,
  cwd: string,
): RememberTags {
  const requested: string[] = Array.isArray(flags['tag']) ? [...flags['tag']] : [];
  if (flags['error']) requested.push('error');
  const all = [...requested];
  for (const pt of extractPathTags(cwd)) {
    if (!all.includes(pt)) all.push(pt);
  }
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const activeScope = explicitScope || detectScope();
  if (activeScope) {
    const scopeTag = `scope:${activeScope}`;
    if (!all.includes(scopeTag)) all.push(scopeTag);
  }
  return { requested, all };
}

// Resolve explicit confidence flag (default: 'verified' for manual remember)
function rememberConfidence(flags: CliFlags): ConfidenceLevel {
  let confidence: ConfidenceLevel = 'verified';
  if (flags['observed']) confidence = 'observed';
  if (flags['inferred']) confidence = 'inferred';
  if (flags['verified']) confidence = 'verified';
  return confidence;
}

const USER_VISIBLE_KINDS = ['distilled', 'superseded'] as const;
type UserVisibleKind = (typeof USER_VISIBLE_KINDS)[number];

function parseKindFlag(flags: CliFlags): UserVisibleKind | undefined {
  const kindFlagRaw = stringFlag(flags, 'kind');
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // 'raw' is reserved for ingestion connectors (deletions go through archiveRawMemory); the append-only trigger aborts forget/consolidate on raw rows,
  // so exposing --kind raw would create unforgettable memories. 'archived' is an internal sentinel set only in that transaction.
  if (kindFlag !== undefined && !isOneOf(USER_VISIBLE_KINDS, kindFlag)) {
    printError(`Invalid --kind: "${kindFlagRaw}". Must be one of: ${USER_VISIBLE_KINDS.join(', ')}`);
    printError(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
    throw new CliExit(1);
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
    printError(ownerCheck.message);
    throw new CliExit(1);
  }
  if (ownerCheck.message) printError(ownerCheck.message);
  const owner = ownerCheck.value ?? null;
  const artifactRef = stringFlag(flags, 'artifact-ref') ?? null;
  const scope = stringFlag(flags, 'scope')?.trim() || null;
  assertClientScope(scope);
  return { kind, owner, artifactRef, scope };
}

async function cmdRemember(
  hippoRoot: string,
  tenantId: string,
  text: string,
  flags: CliFlags
): Promise<void> {
  const useGlobal = boolFlag(flags, 'global');
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const { requested: requestedTags, all: allTags } = rememberTags(flags, process.cwd());
  const envelope = parseRememberEnvelope(flags);

  const ctx = cliApiContext(targetRoot, tenantId);
  const outcome = api.rememberLocally(ctx, {
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
    console.log(`Skipped (salience: ${outcome.reason}, score ${outcome.score.toFixed(2)})`);
    return;
  }
  const weak = outcome.startedWeak;
  if (weak) console.log(`Weakened (salience: ${weak.reason}, strength ${weak.strength.toFixed(2)})`);
  printRemembered(outcome.entry, useGlobal);

  const request = { requested: boolFlag(flags, 'extract'), apiKey: envAnthropicApiKey() };
  printExtraction(await api.extractRememberedFacts(ctx, outcome.entry, request));
}

function printRemembered(entry: MemoryEntry, useGlobal: boolean): void {
  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d | Confidence: ${entry.confidence}`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');
  for (const w of vetSecrets(entry.content, entry.tags, false).warnings) printError(`Warning: ${w}`);
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
async function alreadySupersededLine(hippoRoot: string, oldId: string, tenantId: string, conflict: ConflictError): Promise<string> {
  const by = (await getMemory(cliApiContext(hippoRoot, tenantId), oldId))?.superseded_by;
  return by ? `Error: memory ${oldId} is already superseded by ${by}. Supersede that one instead.` : `Error: ${conflict.message}`;
}

function parseLayerFlag(flags: CliFlags): Layer | undefined {
  const raw = stringFlag(flags, 'layer');
  if (raw === undefined) return undefined;
  const layer = Object.values(Layer).find((l) => l === raw);
  if (layer === undefined) {
    printError(`Invalid --layer: "${raw}". Must be one of: ${Object.values(Layer).join(', ')}`);
    throw new CliExit(1);
  }
  return layer;
}

async function cmdSupersede(
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
    pinned: flagIsTrue(flags, 'pin') ? true : undefined,
  };

  let newId: string;
  try {
    ({ newId } = api.supersede(cliApiContext(hippoRoot, tenantId), oldId, newContent, overrides));
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
    printError(errorMessage(err));
    throw new CliExit(1);
  }
}

function traceTags(flags: CliFlags): string[] {
  const rawTags = flags['tag'];
  return Array.isArray(rawTags)
    ? rawTags.map((t) => String(t))
    : rawTags !== undefined
      ? [String(rawTags)]
      : [];
}

function cmdTraceRecord(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
): void {
  requireInit(hippoRoot);

  const task = String(flags['task'] ?? '').trim();
  const stepsJson = String(flags['steps'] ?? '').trim();
  const outcome = String(flags['outcome'] ?? '').trim();
  const validOutcomes = ['success', 'failure', 'partial'] as const;

  if (!task || !stepsJson || !outcome) {
    printError('Usage: hippo trace record --task <t> --steps <json> --outcome <success|failure|partial> [--session <id>] [--tag <t>]');
    throw new CliExit(1);
  }
  if (!isOneOf(validOutcomes, outcome)) {
    printError(`Invalid outcome: "${outcome}". Must be one of: ${validOutcomes.join(', ')}.`);
    throw new CliExit(1);
  }

  const steps = parseStepsOrExit(stepsJson);

  const sessionId = String(flags['session'] ?? '').trim() || null;
  const tags = traceTags(flags);

  const content = renderTraceContent({
    task,
    steps,
    outcome,
  });

  const { id } = api.remember(cliApiContext(hippoRoot, tenantId), {
    content,
    tags,
    local: {
      layer: Layer.Trace,
      source: String(flags['source'] ?? 'cli'),
      traceOutcome: outcome,
      sourceSessionId: sessionId,
    },
  });

  console.log(`Recorded trace ${id} (outcome=${outcome}, ${steps.length} steps)`);
}

async function cmdTrace(
  hippoRoot: string,
  tenantId: string,
  id: string,
  flags: CliFlags,
): Promise<void> {
  requireInit(hippoRoot);
  const asJson = boolFlag(flags, 'json');

  // Look in local store first, then global.
  let entry = await getMemory(cliApiContext(hippoRoot, tenantId), id);
  let sourceLabel: 'local' | 'global' = 'local';
  const globalRoot = getGlobalRoot();
  if (!entry && isInitialized(globalRoot)) {
    entry = await getMemory(cliApiContext(globalRoot, tenantId), id);
    sourceLabel = 'global';
  }
  if (!entry) {
    printError(`Memory not found: ${id}`);
    throw new CliExit(1);
  }

  const t: TraceView = {
    entry, id, sourceLabel,
    ...traceStats(entry),
    ...(await traceLineage(hippoRoot, globalRoot, entry, id, tenantId)),
  };
  if (asJson) {
    printTraceJson(t);
    return;
  }
  printTraceText(t);
}

type TraceView = ReturnType<typeof traceStats> & Awaited<ReturnType<typeof traceLineage>> & {
  entry: MemoryEntry;
  id: string;
  sourceLabel: 'local' | 'global';
};

function traceStats(entry: MemoryEntry) {
  const now = evalNow();
  const strength = calculateStrength(entry, now);
  const halfLife = entry.half_life_days;
  const rewardFactor = calculateRewardFactor(entry);
  const effHalfLife = halfLife * rewardFactor;
  const createdMs = new Date(entry.created).getTime();
  const ageDays = (now.getTime() - createdMs) / DAY_MS;
  const lastMs = new Date(entry.last_retrieved).getTime();
  const sinceLast = (now.getTime() - lastMs) / DAY_MS;
  const facets = confidenceFacets(entry, now);
  const conf = confidenceLabel(entry, now).text;

  // Projected strength: same decay curve, just push `now` out.
  const projectedAt = (days: number): number =>
    calculateStrength(entry, new Date(now.getTime() + days * DAY_MS));
  return { strength, halfLife, rewardFactor, effHalfLife, ageDays, sinceLast, facets, conf, projectedAt };
}

async function traceLineage(hippoRoot: string, globalRoot: string, entry: MemoryEntry, id: string, tenantId: string) {
  // Parents (consolidation lineage) — schema v9 field.
  const parents = Array.isArray(entry.parents) ? entry.parents : [];
  const parentPreviews: { id: string; content: string }[] = [];
  for (const pid of parents) {
    const p = (await getMemory(cliApiContext(hippoRoot, tenantId), pid))
      ?? (isInitialized(globalRoot) ? await getMemory(cliApiContext(globalRoot, tenantId), pid) : null);
    parentPreviews.push({ id: pid, content: p ? p.content.replace(/\s+/g, ' ').slice(0, PARENT_PREVIEW_CHARS) : '(not found)' });
  }

  // Open conflicts involving this memory.
  const allConflicts = [
    ...listMemoryConflicts(hippoRoot, 'open', tenantId),
    ...(isInitialized(globalRoot) ? listMemoryConflicts(globalRoot, 'open', tenantId) : []),
  ];
  const myConflicts = allConflicts.filter((c) => c.memory_a_id === id || c.memory_b_id === id);
  return { parentPreviews, myConflicts };
}

function printTraceJson(t: TraceView): void {
  const { entry, facets } = t;
  console.log(JSON.stringify({
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
    last_retrieved: entry.last_retrieved,
    days_since_last_retrieval: t.sinceLast,
    retrieval_count: entry.retrieval_count,
    strength_now: t.strength,
    half_life_days: t.halfLife,
    reward_factor: t.rewardFactor,
    effective_half_life_days: t.effHalfLife,
    projected_strength_30d: t.projectedAt(30),
    projected_strength_90d: t.projectedAt(90),
    outcome_positive: entry.outcome_positive,
    outcome_negative: entry.outcome_negative,
    parents: t.parentPreviews,
    open_conflicts: t.myConflicts,
  }, null, 2));
}

function printTraceText(t: TraceView): void {
  const { entry, id, sourceLabel, conf, ageDays, strength, projectedAt, halfLife, rewardFactor, effHalfLife, sinceLast } = t;
  const { parentPreviews, myConflicts } = t;
  console.log(`Memory: ${entry.id}  [${sourceLabel}]`);
  console.log('='.repeat(50));
  console.log(`Content:   ${entry.content.replace(/\s+/g, ' ').slice(0, DETAIL_CONTENT_CHARS)}${entry.content.length > DETAIL_CONTENT_CHARS ? '...' : ''}`);
  console.log(`Layer:     ${entry.layer.padEnd(10)} Confidence: ${conf.padEnd(14)} Pinned: ${entry.pinned ? 'yes' : 'no'}${entry.starred ? '  Starred: yes' : ''}`);
  console.log(`Tags:      ${entry.tags.join(', ') || '(none)'}`);
  console.log(`Created:   ${entry.created}  (${fmt(ageDays, 1)} days ago)`);
  console.log();
  console.log(`Strength trajectory:`);
  console.log(`  now:        ${fmt(strength, 3)}`);
  console.log(`  in 30 days: ${fmt(projectedAt(30), 3)}`);
  console.log(`  in 90 days: ${fmt(projectedAt(90), 3)}`);
  console.log(`  half-life:  ${fmt(halfLife, 1)}d (stored) x ${fmt(rewardFactor, 2)} reward = ${fmt(effHalfLife, 1)}d effective`);
  console.log();
  console.log(`Retrieval:`);
  console.log(`  count:      ${entry.retrieval_count}`);
  console.log(`  last:       ${entry.last_retrieved}  (${fmt(sinceLast, 1)} days ago)`);
  console.log();
  console.log(`Outcomes:   +${entry.outcome_positive} / -${entry.outcome_negative}`);
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
      const other = c.memory_a_id === id ? c.memory_b_id : c.memory_a_id;
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
    printError('Memory content too short (minimum 3 characters).');
    throw new CliExit(1);
  }
  // Thin-client routing: simple `remember` calls go over HTTP so the daemon stays the single writer; rich flags need the direct path.
  // The salience gate is not in richFlag and the route does not apply it, so a routed remember stores what a direct one would skip.
  const richFlag =
    flags['pin'] || flags['global'] || flags['extract'] || flags['force'] ||
    flags['observed'] || flags['inferred'] || flags['verified'] ||
    flags['layer'] !== undefined;
  if (!richFlag && await rememberViaThinClient(hippoRoot, text, flags)) return;
  await cmdRemember(hippoRoot, tenantId, text, flags);
}

async function rememberViaThinClient(hippoRoot: string, text: string, flags: CliFlags): Promise<boolean> {
  const rememberKindRaw = stringFlag(flags, 'kind')?.toLowerCase();
  if (rememberKindRaw !== undefined && !isOneOf(USER_VISIBLE_KINDS, rememberKindRaw)) return false;
  const tags = rememberTags(flags, process.cwd()).all;
  // Validate --owner on the thin-client path too, so validation is the same whether or not a server is up.
  const thinOwnerRaw = stringFlag(flags, 'owner');
  const thinOwnerCheck = validateOwner(thinOwnerRaw, { strict: isStrictOwnerEnv() });
  if (!thinOwnerCheck.ok) {
    printError(thinOwnerCheck.message);
    throw new CliExit(1);
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
    console.log(`Remembered [${result.id}] (via ${info.url})`);
    console.log(`   Kind: ${result.kind} | Tenant: ${result.tenantId}`);
    for (const w of result.warnings ?? []) printError(`Warning: ${w}`);
  });
}

export async function handleSupersede({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const oldId = args[0];
  const newContent = args.slice(1).join(' ').trim();
  if (!oldId || !newContent) {
    printError('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
    throw new CliExit(1);
  }
  await cmdSupersede(hippoRoot, tenantId, oldId, newContent, flags);
}

export async function handleTrace({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sub = args[0] ? String(args[0]) : '';
  if (sub === 'record') {
    cmdTraceRecord(hippoRoot, tenantId, flags);
    return;
  }
  if (!sub) {
    printError('Usage: hippo trace <memory-id> | hippo trace record --task <t> --steps <json> --outcome <o>');
    throw new CliExit(1);
  }
  await cmdTrace(hippoRoot, tenantId, sub, flags);
}
