// The write verbs: `hippo remember`, `hippo supersede` and `hippo trace`.

import { evalNow } from '../ablation.js';
import * as fs from 'fs';
import {
  createMemory,
  createSuccessor,
  calculateStrength,
  calculateRewardFactor,
  confidenceFacets,
  confidenceLabel,
  computeSchemaFit,
  Layer,
  ConfidenceLevel,
} from '../memory.js';
import { isInitialized } from '../store/open.js';
import { writeEntry } from '../store/entry-writes.js';
import { readEntry, loadAllEntries } from '../store/entry-reads.js';
import { updateStats } from '../store/index-and-stats.js';
import { listMemoryConflicts } from '../store/conflicts.js';
import { RejectedValueError } from '../rejection.js';
import { renderTraceContent, parseSteps } from '../trace.js';
import { embedMemory } from '../embeddings.js';
import { loadConfig } from '../config.js';
import { extractPathTags } from '../path-context.js';
import { detectScope } from '../scope.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { vetSecrets } from '../secret-detect.js';
import * as client from '../client.js';
import { resolveTenantId } from '../tenant.js';
import { computeSalience } from '../salience.js';
import { validateOwner, isStrictOwnerEnv } from '../owner-validation.js';
import { printError } from './output.js';
import { emitCliAudit, requireInit, runViaServerIfAvailable, fmt, type CommandContext } from './shared.js';

// `requested` is what the caller typed; `all` adds path and scope tags from this process's cwd and env.
interface RememberTags {
  requested: string[];
  all: string[];
}

// Shared by the direct write and the routed request so both store the same tags.
function rememberTags(
  flags: Record<string, string | boolean | string[]>,
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

async function cmdRemember(
  hippoRoot: string,
  text: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const useGlobal = Boolean(flags['global']);
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const { requested: requestedTags, all: allTags } = rememberTags(flags, process.cwd());

  // Resolve explicit confidence flag (default: 'verified' for manual remember)
  let confidence: ConfidenceLevel = 'verified';
  if (flags['observed']) confidence = 'observed';
  if (flags['inferred']) confidence = 'inferred';
  if (flags['verified']) confidence = 'verified';

  // Schema fit needs the store, which the routed request has no access to, so it stays here.
  const existing = loadAllEntries(targetRoot, resolveTenantId({}));
  const schemaFit = computeSchemaFit(text, requestedTags, existing);

  // A3 envelope flags
  const kindFlagRaw = typeof flags['kind'] === 'string' ? (flags['kind'] as string) : undefined;
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // CLI surface intentionally restricted: 'raw' is reserved for ingestion connectors
  // (E1.x: Slack/Jira/Gmail) that route deletions through archiveRawMemory. Existing
  // forget/consolidate/conflict-resolve paths abort on kind='raw' via the append-only
  // trigger, so exposing --kind raw here would create unforgettable memories.
  // 'archived' is an internal sentinel set only inside archiveRawMemory's transaction.
  const userVisibleKinds = ['distilled', 'superseded'] as const;
  if (kindFlag !== undefined && !(userVisibleKinds as readonly string[]).includes(kindFlag)) {
    printError(`Invalid --kind: "${kindFlagRaw}". Must be one of: ${userVisibleKinds.join(', ')}`);
    printError(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
    process.exit(1);
  }
  const ownerRaw = typeof flags['owner'] === 'string' ? (flags['owner'] as string) : null;
  const ownerCheck = validateOwner(ownerRaw, { strict: isStrictOwnerEnv() });
  if (!ownerCheck.ok) {
    printError(ownerCheck.message);
    process.exit(1);
  }
  if (ownerCheck.message) printError(ownerCheck.message);
  const ownerFlag = ownerCheck.value ?? null;
  const artifactRefFlag = typeof flags['artifact-ref'] === 'string' ? (flags['artifact-ref'] as string) : null;
  const scopeForEnvelope = typeof flags['scope'] === 'string' ? (flags['scope'] as string).trim() || null : null;

  // A5 stub auth: stamp tenant_id from env (HIPPO_TENANT) so recall isolation
  // can filter on this row. Default tenant 'default' for unauthenticated CLI.
  const tenantId = resolveTenantId({});
  const rememberConfig = loadConfig(targetRoot);

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: allTags,
    pinned: Boolean(flags['pin']),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence,
    schema_fit: schemaFit,
    kind: kindFlag as ('raw' | 'distilled' | 'superseded' | 'archived' | undefined),
    scope: scopeForEnvelope,
    owner: ownerFlag,
    artifact_ref: artifactRefFlag,
    tenantId,
    baseHalfLifeDays: rememberConfig.defaultHalfLifeDays,
  });

  // Salience gate: decide if this memory is worth storing
  if (rememberConfig.salience.enabled && !Boolean(flags['pin']) && !Boolean(flags['force'])) {
    const salienceResult = computeSalience(text, entry.tags, existing, {
      recentWindow: rememberConfig.salience.recentWindow,
      overlapThreshold: rememberConfig.salience.overlapThreshold,
      minContentLength: rememberConfig.salience.minContentLength,
      maxRepeatErrors: rememberConfig.salience.maxRepeatErrors,
    });
    if (salienceResult.decision === 'skip') {
      console.log(`Skipped (salience: ${salienceResult.reason}, score ${salienceResult.score.toFixed(2)})`);
      return;
    }
    if (salienceResult.decision === 'start_weak') {
      entry.strength = salienceResult.score;
      entry.half_life_days = Math.max(1, entry.half_life_days * 0.5);
      console.log(`Weakened (salience: ${salienceResult.reason}, strength ${salienceResult.score.toFixed(2)})`);
    }
  }

  writeEntry(targetRoot, entry);
  updateStats(targetRoot, { remembered: 1 });

  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d | Confidence: ${entry.confidence}`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');
  for (const w of vetSecrets(entry.content, entry.tags, false).warnings) printError(`Warning: ${w}`);

  void embedMemory(targetRoot, entry);

  const config = loadConfig(targetRoot);
  const shouldExtract = flags['extract'] || config.extraction.enabled === true;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

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
      printError(`  (extraction failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  } else if (shouldExtract && !apiKey) {
    printError('  (extraction skipped: ANTHROPIC_API_KEY not set)');
  }
}

function cmdSupersede(
  hippoRoot: string,
  oldId: string,
  newContent: string,
  flags: Record<string, string | boolean | string[]>,
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

  const layer = typeof flags['layer'] === 'string' ? (flags['layer'] as Layer) : undefined;
  const rawTags = flags['tag'];
  const tags = Array.isArray(rawTags)
    ? (rawTags as string[]).map((t) => String(t))
    : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
  const pinned = flags['pin'] === true || old.pinned;

  const newEntry = createSuccessor(old, newContent, {
    tenantId: old.tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    layer,
    tags,
    pinned,
  });

  // AT1: write the SUCCESSOR first. The rejection guard fires on the new
  // content — if it refuses, nothing has been mutated yet (the old ordering
  // committed old.superseded_by before the guarded new write, leaving a
  // dangling pointer to an id that was never created). If the old-row write
  // below fails instead, the new row exists unpointered — an orphan
  // successor, strictly less harmful than a dangling pointer. NOTE: unlike
  // api.supersede (whose CAS + insert commit in ONE transaction), this CLI
  // path is two independent writes and stays non-atomic; write order is its
  // only ordering guarantee.
  try {
    writeEntry(hippoRoot, newEntry);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  old.superseded_by = newEntry.id;
  writeEntry(hippoRoot, old);
  emitCliAudit(hippoRoot, 'supersede', oldId, { newId: newEntry.id });

  console.log(`Superseded ${oldId} → ${newEntry.id}`);
}

function cmdTraceRecord(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
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

  let steps;
  try {
    steps = parseSteps(stepsJson);
  } catch (err) {
    printError(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const sessionId = String(flags['session'] ?? '').trim() || null;
  const rawTags = flags['tag'];
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => String(t))
    : rawTags !== undefined
      ? [String(rawTags)]
      : [];

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
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);
  const asJson = Boolean(flags['json']);
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

  const now = evalNow();
  const strength = calculateStrength(entry, now);
  const halfLife = entry.half_life_days;
  const rewardFactor = calculateRewardFactor(entry);
  const effHalfLife = halfLife * rewardFactor;
  const createdMs = new Date(entry.created).getTime();
  const ageDays = (now.getTime() - createdMs) / 86_400_000;
  const lastMs = new Date(entry.last_retrieved).getTime();
  const sinceLast = (now.getTime() - lastMs) / 86_400_000;
  const facets = confidenceFacets(entry, now);
  const conf = confidenceLabel(entry, now).text;

  // Projected strength: same decay curve, just push `now` out.
  const projectedAt = (days: number): number =>
    calculateStrength(entry, new Date(now.getTime() + days * 86_400_000));

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

  if (asJson) {
    console.log(JSON.stringify({
      id: entry.id,
      source: sourceLabel,
      layer: entry.layer,
      confidence: facets.tier,
      aged_out: facets.agedOut,
      pinned: entry.pinned,
      starred: entry.starred,
      tags: entry.tags,
      content: entry.content,
      created: entry.created,
      age_days: ageDays,
      last_retrieved: entry.last_retrieved,
      days_since_last_retrieval: sinceLast,
      retrieval_count: entry.retrieval_count,
      strength_now: strength,
      half_life_days: halfLife,
      reward_factor: rewardFactor,
      effective_half_life_days: effHalfLife,
      projected_strength_30d: projectedAt(30),
      projected_strength_90d: projectedAt(90),
      outcome_positive: entry.outcome_positive,
      outcome_negative: entry.outcome_negative,
      parents: parentPreviews,
      open_conflicts: myConflicts,
    }, null, 2));
    return;
  }

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
  // stores what a direct one would skip. Measured 2026-09-07, tracked in
  // TODOS.md; do not read this list as covering salience.
  const richFlag =
    flags['pin'] || flags['global'] || flags['extract'] || flags['force'] ||
    flags['observed'] || flags['inferred'] || flags['verified'] ||
    flags['layer'] !== undefined;
  if (!richFlag) {
    const rememberKindRaw = typeof flags['kind'] === 'string' ? (flags['kind'] as string).toLowerCase() : undefined;
    const rememberKindAllowed = ['distilled', 'superseded'] as const;
    if (rememberKindRaw === undefined || (rememberKindAllowed as readonly string[]).includes(rememberKindRaw)) {
      const tags = rememberTags(flags, process.cwd()).all;
      // B2 v1.12.6 — validate --owner on the thin-client path too.
      // Failure on this path exits early so the user gets the same
      // validation experience whether or not a server is up.
      const thinOwnerRaw = typeof flags['owner'] === 'string' ? (flags['owner'] as string) : undefined;
      const thinOwnerCheck = validateOwner(thinOwnerRaw, { strict: isStrictOwnerEnv() });
      if (!thinOwnerCheck.ok) {
        printError(thinOwnerCheck.message);
        process.exit(1);
      }
      if (thinOwnerCheck.message) printError(thinOwnerCheck.message);
      const remembered = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
        const result = await client.remember(info.url, apiKey, {
          content: text,
          kind: rememberKindRaw as ('distilled' | 'superseded' | undefined),
          scope: typeof flags['scope'] === 'string' ? (flags['scope'] as string) : undefined,
          owner: thinOwnerCheck.value,
          artifactRef: typeof flags['artifact-ref'] === 'string' ? (flags['artifact-ref'] as string) : undefined,
          tags,
        });
        console.log(`Remembered [${result.id}] (via ${info.url})`);
        console.log(`   Kind: ${result.kind} | Tenant: ${result.tenantId}`);
        for (const w of result.warnings ?? []) printError(`Warning: ${w}`);
      });
      if (remembered) return;
    }
  }
  await cmdRemember(hippoRoot, text, flags);
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
