// The write verbs: `hippo remember`, `hippo supersede` and `hippo trace`.

import { envAnthropicApiKey } from '../env.js';
import { evalNow } from '../ablation.js';
import * as fs from 'fs';
import {
  createMemory,
  createSuccessor,
  calculateStrength,
  calculateRewardFactor,
  confidenceFacets,
  confidenceLabel,
  Layer,
  ConfidenceLevel,
  type MemoryEntry,
} from '../memory.js';
import { isInitialized } from '../store/open.js';
import { writeEntry } from '../store/entry-writes.js';
import { readEntry, loadAllEntries } from '../store/entry-reads.js';
import { loadNewestEntries, schemaFitInStore } from '../store/candidates.js';
import { updateStats } from '../store/index-and-stats.js';
import { listMemoryConflicts } from '../store/conflicts.js';
import { RejectedValueError } from '../rejection.js';
import { renderTraceContent, parseSteps } from '../trace.js';
import { embedMemory } from '../embeddings.js';
import { loadConfig, type HippoConfig } from '../config.js';
import { extractPathTags } from '../path-context.js';
import { detectScope } from '../scope.js';
import { assertClientScope } from '../recall-scope.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { vetSecrets } from '../secret-detect.js';
import * as client from './client.js';
import { resolveTenantId } from '../tenant.js';
import { computeSalience } from '../salience.js';
import { validateOwner, isStrictOwnerEnv } from './owner-validation.js';
import { printError } from './output.js';
import { emitCliAudit, requireInit, runViaServerIfAvailable, fmt, type CliFlags, type CommandContext, boolFlag, flagIsTrue, stringFlag } from './shared.js';
import { DAY_MS } from '../util/time.js';
import { errorMessage } from '../log.js';

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
  const requested: string[] = Array.isArray(flags['tag']) ? [...(flags['tag'] as string[])] : [];
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

function parseKindFlag(flags: CliFlags): string | undefined {
  const kindFlagRaw = stringFlag(flags, 'kind');
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // CLI surface intentionally restricted: 'raw' is reserved for ingestion connectors
  // that route deletions through archiveRawMemory. Existing
  // forget/consolidate/conflict-resolve paths abort on kind='raw' via the append-only
  // trigger, so exposing --kind raw here would create unforgettable memories.
  // 'archived' is an internal sentinel set only inside archiveRawMemory's transaction.
  const userVisibleKinds = ['distilled', 'superseded'] as const;
  if (kindFlag !== undefined && !(userVisibleKinds as readonly string[]).includes(kindFlag)) {
    printError(`Invalid --kind: "${kindFlagRaw}". Must be one of: ${userVisibleKinds.join(', ')}`);
    printError(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
    process.exit(1);
  }
  return kindFlag;
}

interface RememberEnvelope {
  kind: string | undefined;
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
    process.exit(1);
  }
  if (ownerCheck.message) printError(ownerCheck.message);
  const owner = ownerCheck.value ?? null;
  const artifactRef = stringFlag(flags, 'artifact-ref') ?? null;
  const scope = stringFlag(flags, 'scope')?.trim() || null;
  assertClientScope(scope);
  return { kind, owner, artifactRef, scope };
}

/** @internal Exported so tests/remember-origin-parity.test.ts runs the real direct write; not a stable public API. */
export async function cmdRemember(
  hippoRoot: string,
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
  const confidence = rememberConfidence(flags);

  // Schema fit needs the store, which the routed request has no access to, so it stays here.
  const schemaFit = schemaFitInStore(targetRoot, resolveTenantId({}), text, requestedTags);
  const envelope = parseRememberEnvelope(flags);

  // Stamp tenant_id from env (HIPPO_TENANT) so recall isolation can filter on this row; unauthenticated CLI gets 'default'.
  const tenantId = resolveTenantId({});
  const rememberConfig = loadConfig(targetRoot);

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: allTags,
    pinned: boolFlag(flags, 'pin'),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence,
    schema_fit: schemaFit,
    kind: envelope.kind as ('raw' | 'distilled' | 'superseded' | 'archived' | undefined),
    scope: envelope.scope,
    owner: envelope.owner,
    artifact_ref: envelope.artifactRef,
    tenantId,
    baseHalfLifeDays: rememberConfig.defaultHalfLifeDays,
  });

  if (!passesSalienceGate(entry, text, targetRoot, rememberConfig, flags)) return;

  writeEntry(targetRoot, entry);
  updateStats(targetRoot, { remembered: 1 });
  printRemembered(entry, useGlobal);

  void embedMemory(targetRoot, entry);
  await extractRememberFacts(targetRoot, entry, flags);
}

/** False when the gate skips the write; a start_weak verdict weakens `entry` in place. */
function passesSalienceGate(
  entry: MemoryEntry,
  text: string,
  targetRoot: string,
  rememberConfig: HippoConfig,
  flags: CliFlags,
): boolean {
  if (!rememberConfig.salience.enabled || boolFlag(flags, 'pin') || boolFlag(flags, 'force')) return true;
  // computeSalience compares against the last `recentWindow` rows only; below 1 its slice takes every row, so that case still loads them all.
  const window = Math.trunc(rememberConfig.salience.recentWindow);
  const recent = Number.isSafeInteger(window) && window >= 1
    ? loadNewestEntries(targetRoot, entry.tenantId, window)
    : loadAllEntries(targetRoot, entry.tenantId);
  const salienceResult = computeSalience(text, entry.tags, recent, {
    recentWindow: rememberConfig.salience.recentWindow,
    overlapThreshold: rememberConfig.salience.overlapThreshold,
    minContentLength: rememberConfig.salience.minContentLength,
    maxRepeatErrors: rememberConfig.salience.maxRepeatErrors,
  });
  if (salienceResult.decision === 'skip') {
    console.log(`Skipped (salience: ${salienceResult.reason}, score ${salienceResult.score.toFixed(2)})`);
    return false;
  }
  if (salienceResult.decision === 'start_weak') {
    entry.strength = salienceResult.score;
    entry.half_life_days = Math.max(1, entry.half_life_days * 0.5);
    console.log(`Weakened (salience: ${salienceResult.reason}, strength ${salienceResult.score.toFixed(2)})`);
  }
  return true;
}

function printRemembered(entry: MemoryEntry, useGlobal: boolean): void {
  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d | Confidence: ${entry.confidence}`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');
  for (const w of vetSecrets(entry.content, entry.tags, false).warnings) printError(`Warning: ${w}`);
}

async function extractRememberFacts(targetRoot: string, entry: MemoryEntry, flags: CliFlags): Promise<void> {
  const config = loadConfig(targetRoot);
  const shouldExtract = flags['extract'] || config.extraction.enabled === true;
  const apiKey = envAnthropicApiKey() ?? '';

  if (shouldExtract && apiKey) {
    try {
      const { extractFacts, storeExtractedFacts } = await import('../extract.js');
      const facts = await extractFacts(entry.content, {
        apiKey,
        model: config.extraction.model,
        onError: (msg) => printError(`  (extraction failed: ${msg})`),
      });
      if (facts.length > 0) {
        storeExtractedFacts(targetRoot, entry, facts);
        printError(`  extracted ${facts.length} fact(s)`);
      }
    } catch (err) {
      // Extraction is best-effort: report it, never block remember.
      printError(`  (extraction failed: ${errorMessage(err)})`);
    }
  } else if (shouldExtract && !apiKey) {
    printError('  (extraction skipped: ANTHROPIC_API_KEY not set)');
  }
}

function supersedeTags(flags: CliFlags): string[] | undefined {
  const rawTags = flags['tag'];
  return Array.isArray(rawTags)
    ? (rawTags as string[]).map((t) => String(t))
    : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
}

function writeSuccessor(hippoRoot: string, newEntry: MemoryEntry): void {
  try {
    writeEntry(hippoRoot, newEntry);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function cmdSupersede(
  hippoRoot: string,
  oldId: string,
  newContent: string,
  flags: CliFlags,
): void {
  requireInit(hippoRoot);

  const old = readEntry(hippoRoot, oldId, resolveTenantId({}));
  if (!old) {
    printError(`Error: memory ${oldId} not found.`);
    process.exit(1);
  }
  if (old.superseded_by) {
    printError(`Error: memory ${oldId} is already superseded by ${old.superseded_by}. Supersede that one instead.`);
    process.exit(1);
  }

  const layer = stringFlag(flags, 'layer') as Layer | undefined;
  const tags = supersedeTags(flags);
  const pinned = flagIsTrue(flags, 'pin') || old.pinned;

  const newEntry = createSuccessor(old, newContent, {
    tenantId: old.tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    layer,
    tags,
    pinned,
  });

  // Write the SUCCESSOR first: a rejection-guard refusal then mutates nothing, and an old-row failure leaves an
  // orphan successor rather than a dangling pointer. Unlike api.supersede this path is two non-atomic writes.
  writeSuccessor(hippoRoot, newEntry);
  old.superseded_by = newEntry.id;
  writeEntry(hippoRoot, old);
  emitCliAudit(hippoRoot, 'supersede', oldId, { newId: newEntry.id });

  console.log(`Superseded ${oldId} → ${newEntry.id}`);
}

function parseStepsOrExit(stepsJson: string): ReturnType<typeof parseSteps> {
  try {
    return parseSteps(stepsJson);
  } catch (err) {
    printError(String(err instanceof Error ? err.message : err));
    process.exit(1);
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
  flags: CliFlags,
): void {
  requireInit(hippoRoot);

  const task = String(flags['task'] ?? '').trim();
  const stepsJson = String(flags['steps'] ?? '').trim();
  const outcome = String(flags['outcome'] ?? '').trim();
  const validOutcomes = ['success', 'failure', 'partial'];

  if (!task || !stepsJson || !outcome) {
    printError('Usage: hippo trace record --task <t> --steps <json> --outcome <success|failure|partial> [--session <id>] [--tag <t>]');
    process.exit(1);
  }
  if (!validOutcomes.includes(outcome)) {
    printError(`Invalid outcome: "${outcome}". Must be one of: ${validOutcomes.join(', ')}.`);
    process.exit(1);
  }

  const steps = parseStepsOrExit(stepsJson);

  const sessionId = String(flags['session'] ?? '').trim() || null;
  const tags = traceTags(flags);

  const content = renderTraceContent({
    task,
    steps,
    outcome: outcome as 'success' | 'failure' | 'partial',
  });

  const entry = createMemory(content, {
    layer: Layer.Trace,
    tags,
    source: String(flags['source'] ?? 'cli'),
    trace_outcome: outcome as 'success' | 'failure' | 'partial',
    source_session_id: sessionId,
    tenantId: resolveTenantId({}),
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
  });

  writeEntry(hippoRoot, entry);

  console.log(`Recorded trace ${entry.id} (outcome=${outcome}, ${steps.length} steps)`);
}

function cmdTrace(
  hippoRoot: string,
  id: string,
  flags: CliFlags,
): void {
  requireInit(hippoRoot);
  const asJson = boolFlag(flags, 'json');
  const tenantId = resolveTenantId({});

  // Look in local store first, then global.
  let entry = readEntry(hippoRoot, id, tenantId);
  let sourceLabel: 'local' | 'global' = 'local';
  const globalRoot = getGlobalRoot();
  if (!entry && isInitialized(globalRoot)) {
    entry = readEntry(globalRoot, id, tenantId);
    sourceLabel = 'global';
  }
  if (!entry) {
    printError(`Memory not found: ${id}`);
    process.exit(1);
  }

  const t: TraceView = {
    entry, id, sourceLabel,
    ...traceStats(entry),
    ...traceLineage(hippoRoot, globalRoot, entry, id, tenantId),
  };
  if (asJson) {
    printTraceJson(t);
    return;
  }
  printTraceText(t);
}

type TraceView = ReturnType<typeof traceStats> & ReturnType<typeof traceLineage> & {
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

function traceLineage(hippoRoot: string, globalRoot: string, entry: MemoryEntry, id: string, tenantId: string) {
  // Parents (consolidation lineage) — schema v9 field.
  const parents = Array.isArray(entry.parents) ? entry.parents : [];
  const parentPreviews = parents.map((pid) => {
    const p = readEntry(hippoRoot, pid, tenantId) ?? (isInitialized(globalRoot) ? readEntry(globalRoot, pid, tenantId) : null);
    return { id: pid, content: p ? p.content.replace(/\s+/g, ' ').slice(0, 70) : '(not found)' };
  });

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
  console.log(`Content:   ${entry.content.replace(/\s+/g, ' ').slice(0, 160)}${entry.content.length > 160 ? '...' : ''}`);
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

export async function handleRemember({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  let text: string;
  if (args.length === 1 && args[0] === '-') {
    text = fs.readFileSync(0, 'utf-8').trim();
  } else {
    text = args.join(' ').trim();
  }
  if (!text || text.length < 3) {
    printError('Memory content too short (minimum 3 characters).');
    process.exit(1);
  }
  // Thin-client routing. When a server is up, simple `remember` calls go
  // over HTTP so the daemon stays single-writer (footgun #2). Rich CLI
  // flags (--pin, --layer, --extract, --global) still need the direct
  // path; we only intercept the minimal envelope. The salience gate is
  // NOT in richFlag and the route does not apply it, so a routed remember
  // stores what a direct one would skip; do not read this list as covering salience.
  const richFlag =
    flags['pin'] || flags['global'] || flags['extract'] || flags['force'] ||
    flags['observed'] || flags['inferred'] || flags['verified'] ||
    flags['layer'] !== undefined;
  if (!richFlag && await rememberViaThinClient(hippoRoot, text, flags)) return;
  await cmdRemember(hippoRoot, text, flags);
}

async function rememberViaThinClient(hippoRoot: string, text: string, flags: CliFlags): Promise<boolean> {
  const rememberKindRaw = stringFlag(flags, 'kind')?.toLowerCase();
  const rememberKindAllowed = ['distilled', 'superseded'] as const;
  if (rememberKindRaw !== undefined && !(rememberKindAllowed as readonly string[]).includes(rememberKindRaw)) return false;
  const tags = rememberTags(flags, process.cwd()).all;
  // Validate --owner on the thin-client path too, so validation is the same whether or not a server is up.
  const thinOwnerRaw = stringFlag(flags, 'owner');
  const thinOwnerCheck = validateOwner(thinOwnerRaw, { strict: isStrictOwnerEnv() });
  if (!thinOwnerCheck.ok) {
    printError(thinOwnerCheck.message);
    process.exit(1);
  }
  if (thinOwnerCheck.message) printError(thinOwnerCheck.message);
  return runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
    const result = await client.remember(info.url, apiKey, {
      content: text,
      kind: rememberKindRaw as ('distilled' | 'superseded' | undefined),
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

export function handleSupersede({ hippoRoot, args, flags }: CommandContext): void {
  const oldId = args[0];
  const newContent = args.slice(1).join(' ').trim();
  if (!oldId || !newContent) {
    printError('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
    process.exit(1);
  }
  cmdSupersede(hippoRoot, oldId, newContent, flags);
}

export function handleTrace({ hippoRoot, args, flags }: CommandContext): void {
  const sub = args[0] ? String(args[0]) : '';
  if (sub === 'record') {
    cmdTraceRecord(hippoRoot, flags);
    return;
  }
  if (!sub) {
    printError('Usage: hippo trace <memory-id> | hippo trace record --task <t> --steps <json> --outcome <o>');
    process.exit(1);
  }
  cmdTrace(hippoRoot, sub, flags);
}
