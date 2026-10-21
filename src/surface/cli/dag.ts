// DAG summary verbs: `hippo dag`, `hippo assemble` and `hippo drill`.

import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import { DAG_LEVEL, type MemoryEntry } from '../../base/memory/memory.js';
import * as api from '../../api/index.js';
import { assembleCost, assembleHeading, drillCost, settleTokens } from '../../api/context-render.js';
import { memoryList } from '../../api/memories/memories.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  numberFlag,
  parseBudgetFlag,
  stringFlag,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { CONTENT_PREVIEW_CHARS } from '../../base/util/token-text.js';
import { CliExit, fail } from './exit.js';

const TREE_CHILD_PREVIEW_CHARS = 70;
const TREE_LEAF_PREVIEW_CHARS = 60;
const DAG_HEAD_CHARS = 120;
const DAG_SUMMARY_PREVIEW_CHARS = 200;
const DAG_CHILD_PREVIEW_CHARS = 100;

export async function handleDag({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const entries = await memoryList(cliApiContext(hippoRoot, tenantId), { everyTenant: true });
  const isStats = boolFlag(flags, 'stats');

  const byLevel = new Map<number, number>();
  let unlinked = 0;

  for (const entry of entries) {
    const level = entry.dagLevel ?? 0;
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
    if (level === DAG_LEVEL.extracted && !entry.dagParentId) unlinked++;
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

function groupByParent(entries: readonly MemoryEntry[]): Map<string, MemoryEntry[]> {
  const byParent = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (!e.dagParentId) continue;
    const list = byParent.get(e.dagParentId) ?? [];
    list.push(e);
    byParent.set(e.dagParentId, list);
  }
  return byParent;
}

function printDagTree(entries: readonly MemoryEntry[]): void {
  // Tree view: L3 entity profiles as roots with L2 children indented, then orphan L2 summaries at top level.
  const profiles = entries.filter((e) => e.dagLevel === DAG_LEVEL.entity);
  const l2List = entries.filter((e) => e.dagLevel === DAG_LEVEL.topic);
  const orphanL2 = l2List.filter((e) => !e.dagParentId);
  const childL2ByProfile = new Map<string, typeof l2List>();
  for (const l2 of l2List) {
    if (!l2.dagParentId) continue;
    const list = childL2ByProfile.get(l2.dagParentId) ?? [];
    list.push(l2);
    childL2ByProfile.set(l2.dagParentId, list);
  }

  const childrenByParent = groupByParent(entries);

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
      const facts = childrenByParent.get(l2.id) ?? [];
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
    const children = childrenByParent.get(summary.id) ?? [];
    for (const child of children) {
      console.log(`   └─ ${child.content.slice(0, TREE_CHILD_PREVIEW_CHARS)}`);
    }
  }
}

async function assembleSession(hippoRoot: string, tenantId: string, sessionId: string, flags: CliFlags): Promise<void> {
  requireInit(hippoRoot);
  // Absent stays undefined so the api default applies.
  const budget = parseBudgetFlag(flags, undefined);
  const freshTailCount = numberFlag(flags, 'fresh-tail');
  const summarizeOlder = !boolFlag(flags, 'no-summarize-older');
  const scope = stringFlag(flags, 'scope') || undefined;
  const ctx: api.Context = {
    ...cliApiContext(hippoRoot, tenantId),
    actor: api.adminActor('cli:assemble'),
  };
  const opts: api.AssembleOptions = {};
  if (Number.isFinite(budget) && budget! > 0) opts.budget = budget;
  if (Number.isFinite(freshTailCount) && freshTailCount! >= 0) opts.freshTailCount = freshTailCount;
  opts.summarizeOlder = summarizeOlder;
  if (scope !== undefined) opts.scope = scope;
  opts.cost = assembleCost(sessionId);
  const r = await api.assemble(ctx, sessionId, opts);
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(
    settleTokens((t) => {
      const rows = r.items.map((it) => {
        const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
        const head = it.content.slice(0, DAG_HEAD_CHARS);
        return `  ${prefix} ${it.createdAt} ${it.id} \u2014 ${head}${it.content.length > DAG_HEAD_CHARS ? '…' : ''}`;
      });
      return [assembleHeading({ ...r, items: r.items.length, tokens: t }), ...rows].join('\n');
    }),
  );
}

// --depth N walks N levels down (default 1, hard cap 10); out-of-range is rejected, never silently clamped.
function drillDepthFlag(flags: CliFlags): number | undefined {
  const depth = numberFlag(flags, 'depth');
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 10)) {
    printError(`--depth must be an integer between 1 and 10 (got ${stringFlag(flags, 'depth')})`);
    throw new CliExit(2);
  }
  return depth;
}

async function drillIntoSummary(
  hippoRoot: string,
  tenantId: string,
  summaryId: string,
  flags: CliFlags,
): Promise<void> {
  requireInit(hippoRoot);
  const limit = numberFlag(flags, 'limit');
  // Absent stays undefined so the api default applies.
  const budget = parseBudgetFlag(flags, undefined);
  const depth = drillDepthFlag(flags);
  const ctx: api.Context = {
    ...cliApiContext(hippoRoot, tenantId),
    actor: api.adminActor('cli:drill'),
  };
  const opts: api.DrillDownOptions = {};
  if (Number.isFinite(limit) && limit! > 0) opts.limit = limit;
  if (Number.isFinite(budget) && budget! > 0) opts.budget = budget;
  if (depth !== undefined) opts.depth = depth;
  opts.cost = drillCost;
  const r = await api.drillDown(ctx, summaryId, opts);
  if ('failure' in r) {
    // Only `not_drillable` is caller-actionable. `not_found` collapses cross-tenant, scope-blocked and missing on
    // purpose: telling scope_blocked apart would leak that the row exists.
    if (r.failure === 'not_drillable') {
      printError(`Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`);
    } else {
      printError(`No drillable summary at id=${summaryId}.`);
    }
    throw new CliExit(1);
  }
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(
    `Summary ${r.summary.id} — ${r.summary.descendantCount} descendants` +
      `${r.summary.earliestAt ? ` (${r.summary.earliestAt} → ${r.summary.latestAt})` : ''}`,
  );
  console.log(`  ${truncateWithEllipsis(r.summary.content, DAG_SUMMARY_PREVIEW_CHARS, '…')}`);
  console.log(`\nChildren (${r.children.length}/${r.totalChildren}${r.truncated ? ', truncated' : ''}):`);
  for (const c of r.children) {
    console.log(`  [L${c.dagLevel}] ${c.id} — ${truncateWithEllipsis(c.content, DAG_CHILD_PREVIEW_CHARS, '…')}`);
  }
}

export async function handleDrill({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const summaryId = args[0];
  if (!summaryId) {
    fail('Usage: hippo drill <summary-id> [--limit N] [--budget N]');
  }
  await drillIntoSummary(hippoRoot, tenantId, summaryId, flags);
}

export async function handleAssemble({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const sessionId = stringFlag(flags, 'session') ?? args[0];
  if (!sessionId) {
    fail('Usage: hippo assemble --session <id> [--budget N] [--fresh-tail N] [--no-summarize-older] [--json]');
  }
  await assembleSession(hippoRoot, tenantId, sessionId, flags);
}
