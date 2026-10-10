// DAG summary verbs: `hippo dag`, `hippo assemble` and `hippo drill`.

import { loadAllEntries } from '../store/entry-reads.js';
import type { MemoryEntry } from '../core/memory.js';
import * as api from '../api/index.js';
import { assembleCost, assembleHeading, drillCost, settleTokens } from '../api/context-render.js';
import { printError } from './output.js';
import { type CliFlags, parseBudgetFlag, type CommandContext, flagIsTrue, stringFlag, numberFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { captureConsole } from './print.js';
import { CONTENT_PREVIEW_CHARS } from '../util/token-text.js';

const TREE_CHILD_PREVIEW_CHARS = 70;
const TREE_LEAF_PREVIEW_CHARS = 60;
const DAG_HEAD_CHARS = 120;
const DAG_SUMMARY_PREVIEW_CHARS = 200;
const DAG_CHILD_PREVIEW_CHARS = 100;

export function handleDag({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const entries = loadAllEntries(hippoRoot);
  const isStats = flagIsTrue(flags, 'stats');

  const byLevel = new Map<number, number>();
  let unlinked = 0;

  for (const entry of entries) {
    const level = entry.dag_level ?? 0;
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
    if (level === 1 && !entry.dag_parent_id) unlinked++;
  }

  if (isStats) {
    printDagStats(byLevel, unlinked);
    return;
  }

  printDagTree(entries);
}

function printDagStats(byLevel: ReadonlyMap<number, number>, unlinked: number): void {
  console.log('DAG Structure:');
  console.log(`  Level 3 (entity profiles):  ${byLevel.get(3) ?? 0}`);
  console.log(`  Level 2 (topic summaries):  ${byLevel.get(2) ?? 0}`);
  console.log(`  Level 1 (extracted facts):  ${byLevel.get(1) ?? 0}`);
  console.log(`  Level 0 (raw memories):     ${byLevel.get(0) ?? 0}`);
  console.log(`  Unlinked facts: ${unlinked}`);
}

function printDagTree(entries: readonly MemoryEntry[]): void {
  // Tree view: L3 entity profiles as roots with L2 children indented, then orphan L2 summaries at top level.
  const profiles = entries.filter((e) => e.dag_level === 3);
  const l2List = entries.filter((e) => e.dag_level === 2);
  const orphanL2 = l2List.filter((e) => !e.dag_parent_id);
  const childL2ByProfile = new Map<string, typeof l2List>();
  for (const l2 of l2List) {
    if (!l2.dag_parent_id) continue;
    const list = childL2ByProfile.get(l2.dag_parent_id) ?? [];
    list.push(l2);
    childL2ByProfile.set(l2.dag_parent_id, list);
  }

  if (profiles.length === 0 && orphanL2.length === 0) {
    console.log('No DAG summaries yet. Run `hippo sleep` with ANTHROPIC_API_KEY set.');
    return;
  }

  // L3 entity profiles as tree roots with their L2 children.
  for (const profile of profiles) {
    const profileTags = profile.tags.filter((t) => t !== 'dag-entity-profile').join(', ');
    console.log(`\n🌲 ${profile.content.slice(0, CONTENT_PREVIEW_CHARS)}`);
    if (profileTags) console.log(`   [${profileTags}]`);
    const l2Children = childL2ByProfile.get(profile.id) ?? [];
    for (const l2 of l2Children) {
      const l2Tags = l2.tags.filter((t) => t !== 'dag-summary').join(', ');
      console.log(`   └─ 📌 ${l2.content.slice(0, TREE_CHILD_PREVIEW_CHARS)}`);
      if (l2Tags) console.log(`      [${l2Tags}]`);
      const facts = entries.filter((e) => e.dag_parent_id === l2.id);
      for (const f of facts) {
        console.log(`      └─ ${f.content.slice(0, TREE_LEAF_PREVIEW_CHARS)}`);
      }
    }
  }

  // Orphan L2 summaries (no L3 parent) at top level.
  for (const summary of orphanL2) {
    const summaryTags = summary.tags.filter((t) => t !== 'dag-summary').join(', ');
    console.log(`\n📌 ${summary.content.slice(0, CONTENT_PREVIEW_CHARS)}`);
    if (summaryTags) console.log(`   [${summaryTags}]`);
    const children = entries.filter((e) => e.dag_parent_id === summary.id);
    for (const child of children) {
      console.log(`   └─ ${child.content.slice(0, TREE_CHILD_PREVIEW_CHARS)}`);
    }
  }
}

async function cmdAssemble(hippoRoot: string, tenantId: string, sessionId: string, flags: CliFlags): Promise<void> {
  requireInit(hippoRoot);
  // Absent stays undefined so the api default applies; the 0 fallback is unreachable.
  const budget = flags['budget'] === undefined ? undefined : parseBudgetFlag(flags['budget'], 0);
  const freshTailCount = numberFlag(flags, 'fresh-tail');
  const summarizeOlder = flags['no-summarize-older'] !== true;
  const scope = stringFlag(flags, 'scope') || undefined;
  const ctx: api.Context = {
    hippoRoot,
    tenantId,
    actor: api.adminActor('cli:assemble'),
  };
  const r = await api.assemble(ctx, sessionId, {
    ...(Number.isFinite(budget) && budget! > 0 ? { budget } : {}),
    ...(Number.isFinite(freshTailCount) && freshTailCount! >= 0 ? { freshTailCount } : {}),
    summarizeOlder,
    ...(scope !== undefined ? { scope } : {}),
    cost: assembleCost(sessionId),
  });
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(settleTokens((t) => captureConsole(() => {
    console.log(assembleHeading({ ...r, items: r.items.length, tokens: t }));
    for (const it of r.items) {
      const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
      const head = it.content.slice(0, DAG_HEAD_CHARS);
      console.log(`  ${prefix} ${it.createdAt} ${it.id} \u2014 ${head}${it.content.length > 120 ? '…' : ''}`);
    }
  })));
}

async function cmdDrillDown(hippoRoot: string, tenantId: string, summaryId: string, flags: CliFlags): Promise<void> {
  requireInit(hippoRoot);
  const limit = numberFlag(flags, 'limit');
  // Absent stays undefined so the api default applies; the 0 fallback is unreachable.
  const budget = flags['budget'] === undefined ? undefined : parseBudgetFlag(flags['budget'], 0);
  // --depth N walks N levels down (default 1, hard cap 10); out-of-range is rejected, never silently clamped.
  const rawDepth = numberFlag(flags, 'depth');
  let depth: number | undefined;
  if (rawDepth !== undefined) {
    if (!Number.isInteger(rawDepth) || rawDepth < 1 || rawDepth > 10) {
      printError(`--depth must be an integer between 1 and 10 (got ${flags['depth']})`);
      process.exit(2);
    }
    depth = rawDepth;
  }
  const ctx: api.Context = {
    hippoRoot,
    tenantId,
    actor: api.adminActor('cli:drill'),
  };
  const r = await api.drillDown(ctx, summaryId, {
    ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
    ...(Number.isFinite(budget) && budget! > 0 ? { budget } : {}),
    ...(depth !== undefined ? { depth } : {}),
    cost: drillCost,
  });
  if ('failure' in r) {
    // Only `not_drillable` is caller-actionable. `not_found` collapses cross-tenant, scope-blocked
    // and missing on purpose: telling scope_blocked apart would leak that the row exists.
    if (r.failure === 'not_drillable') {
      printError(`Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`);
    } else {
      printError(`No drillable summary at id=${summaryId}.`);
    }
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`Summary ${r.summary.id} — ${r.summary.descendantCount} descendants${r.summary.earliestAt ? ` (${r.summary.earliestAt} → ${r.summary.latestAt})` : ''}`);
  console.log(`  ${r.summary.content.slice(0, DAG_SUMMARY_PREVIEW_CHARS)}${r.summary.content.length > DAG_SUMMARY_PREVIEW_CHARS ? '…' : ''}`);
  console.log(`\nChildren (${r.children.length}/${r.totalChildren}${r.truncated ? ', truncated' : ''}):`);
  for (const c of r.children) {
    console.log(`  [L${c.dagLevel}] ${c.id} — ${c.content.slice(0, DAG_CHILD_PREVIEW_CHARS)}${c.content.length > DAG_CHILD_PREVIEW_CHARS ? '…' : ''}`);
  }
}

export async function handleDrill({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const summaryId = args[0];
  if (!summaryId) {
    printError('Usage: hippo drill <summary-id> [--limit N] [--budget N]');
    process.exit(1);
  }
  await cmdDrillDown(hippoRoot, tenantId, summaryId, flags);
}

export async function handleAssemble({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sessionId = stringFlag(flags, 'session') ?? args[0];
  if (!sessionId) {
    printError('Usage: hippo assemble --session <id> [--budget N] [--fresh-tail N] [--no-summarize-older] [--json]');
    process.exit(1);
  }
  await cmdAssemble(hippoRoot, tenantId, sessionId, flags);
}
