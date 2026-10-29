// `hippo trace`: record a decision trace, or show where one memory came from.

import { conflictToWire } from '../../base/memory/conflict-wire.js';
import { type MemoryEntry } from '../../base/memory/entry.js';
import * as api from '../../api/index.js';
import { memoryGet, memoryListByIds } from '../../api/memories/memories.js';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { parseSteps, traceRecord, traceStats } from '../../api/memories/trace.js';
import { requireInit } from './shared.js';
import { fmt } from './print.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  isOneOf,
  stringFlagOrExit,
  stringListFlag,
} from './flag-values.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import type { CliCommand } from './api-context.js';

const PARENT_PREVIEW_CHARS = 70;

const DETAIL_CONTENT_CHARS = 160;

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

async function recordTrace(
  cli: CliCommand,
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
): Promise<void> {
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

  const { id } = await traceRecord(cli.apiContext(hippoRoot, tenantId), {
    task,
    steps,
    outcome,
    sessionId,
    tags,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
  });

  console.log(`Recorded trace ${id} (outcome=${outcome}, ${steps.length} steps)`);
}

interface PrintTraceOptions {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly id: string;
  readonly flags: CliFlags;
}

async function printTrace({
  cli,
  hippoRoot,
  tenantId,
  id,
  flags,
}: PrintTraceOptions): Promise<void> {
  requireInit(hippoRoot);
  const asJson = boolFlag(flags, 'json');

  // Look in local store first, then global.
  const ctx = cli.apiContext(hippoRoot, tenantId);
  let entry = await memoryGet(ctx, id);
  let sourceLabel: 'local' | 'global' = 'local';
  const globalRoot = hippoHomeDir();
  if (!entry && isInitialized(globalRoot)) {
    entry = await memoryGet(cli.apiContext(globalRoot, tenantId), id);
    sourceLabel = 'global';
  }
  if (!entry) {
    fail(`Memory not found: ${id}`);
  }

  const t: TraceView = {
    entry,
    id,
    sourceLabel,
    ...traceStats(entry, ctx),
    ...(await traceLineage({ cli, hippoRoot, globalRoot, entry, id, tenantId })),
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

interface TraceLineageOptions {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly globalRoot: string;
  readonly entry: MemoryEntry;
  readonly id: string;
  readonly tenantId: string;
}

async function traceLineage({
  cli,
  hippoRoot,
  globalRoot,
  entry,
  id,
  tenantId,
}: TraceLineageOptions) {
  // Parents (consolidation lineage) — schema v9 field.
  const parents = Array.isArray(entry.parents) ? entry.parents : [];
  const local =
    parents.length === 0 ? [] : await memoryListByIds(cli.apiContext(hippoRoot, tenantId), parents);
  const found = new Map(local.map((p) => [p.id, p]));
  const missing = parents.filter((pid) => !found.has(pid));
  if (missing.length > 0 && isInitialized(globalRoot)) {
    for (const p of await memoryListByIds(cli.apiContext(globalRoot, tenantId), missing)) {
      found.set(p.id, p);
    }
  }
  const parentPreviews = parents.map((pid) => {
    const p = found.get(pid);
    return {
      id: pid,
      content: p ? p.content.replace(/\s+/g, ' ').slice(0, PARENT_PREVIEW_CHARS) : '(not found)',
    };
  });

  const openIn = async (root: string): Promise<api.ConflictPage['conflicts']> => {
    const mine: api.ConflictPage['conflicts'] = [];
    const ctx = cli.apiContext(root, tenantId);
    for await (const page of api.conflictPages((p) => api.conflictList(ctx, 'open', {}, p))) {
      mine.push(...page.conflicts.filter((c) => c.memoryAId === id || c.memoryBId === id));
    }
    return mine;
  };
  const myConflicts = [
    ...(await openIn(hippoRoot)),
    ...(isInitialized(globalRoot) ? await openIn(globalRoot) : []),
  ];
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
  const { entry, sourceLabel, conf, ageDays, strength, projectedAt } = t;
  const { halfLife, rewardFactor, effHalfLife, sinceLast } = t;
  console.log(`Memory: ${entry.id}  [${sourceLabel}]`);
  console.log('='.repeat(50));
  const ellipsis = entry.content.length > DETAIL_CONTENT_CHARS ? '...' : '';
  console.log(
    `Content:   ${entry.content.replace(/\s+/g, ' ').slice(0, DETAIL_CONTENT_CHARS)}${ellipsis}`,
  );
  const starred = entry.starred ? '  Starred: yes' : '';
  const pinned = entry.pinned ? 'yes' : 'no';
  console.log(
    `Layer:     ${entry.layer.padEnd(10)} Confidence: ${conf.padEnd(14)} Pinned: ${pinned}${starred}`,
  );
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
  printTraceLineage(t);
}

function printTraceLineage({ id, parentPreviews, myConflicts }: TraceView): void {
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

export async function handleTrace({
  hippoRoot,
  tenantId,
  args,
  flags,
  cli,
}: CommandContext): Promise<void> {
  const sub = args[0] ? String(args[0]) : '';
  if (sub === 'record') {
    await recordTrace(cli, hippoRoot, tenantId, flags);
    return;
  }
  if (!sub) {
    fail(
      'Usage: hippo trace <memory-id> | hippo trace record --task <t> --steps <json> --outcome <o>',
    );
  }
  await printTrace({ cli, hippoRoot, tenantId, id: sub, flags });
}
