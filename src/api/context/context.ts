// Ambient context injection: contextGet, the selection it drives and the retrieval it records.
import type { TaskSnapshot } from '../../base/records/sessions.js';
import { markRetrieved } from '../../base/memory/entry.js';
import { dropHeldCopies } from '../../base/util/same-text.js';
import { rethrowIfStoreBlocked } from '../../base/util/store-blocked.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { classifyOriginProject, projectNames } from '../../base/scope/project-identity.js';
import {
  addAmbientTallies,
  ambientStateFromTallies,
  type AmbientState,
  type AmbientTallies,
} from '../../base/memory/ambient.js';
import { assertScopeRequestAllowed } from '../../base/scope/recall-scope.js';
import { selectPinned, selectStrongest } from './context-select.js';
import { selectBySearch } from './context-search.js';
import type { ContextOptions, ContextResult, ContextResultEntry } from './context-types.js';
import { strengthenOf } from '../recall/finish.js';
import { keepShownIds } from '../recall/last-recalled.js';
import type { Context } from '../types.js';
import type { RecallTraceInput } from '../../base/ports/store/recall-writes.js';
import {
  NO_QUERY,
  type ContextPlan,
  sourceOf,
  globalSource,
  planContext,
  promptRecallRequest,
  openBlockBudget,
} from './context-plan.js';
import { ambientAdmission, loadPools } from './context-pools.js';
import { type TaskSections, loadTaskSections } from './context-task-state.js';

/** Tokens a context block may use when the caller sets no budget; the hook command and the CLI
 * default match it. */
export const DEFAULT_CONTEXT_BUDGET = 1500;

/** Assembles a budget-bounded, tenant-scoped context bundle and keeps its ids as the client's
 * last shown list. */
export async function contextGet(ctx: Context, opts: ContextOptions): Promise<ContextResult> {
  const result = await assembleContext(ctx, opts);
  keepShownIds(
    ctx,
    result.entries.map((r) => r.entry.id),
  );
  return result;
}

/** contextGet without the shown list, for the prompt hook, whose block is no answer an outcome
 * should land on; mutates `last_retrieval_ids` and emits a 'recall' audit row for non-pinned,
 * non-'*' queries. Returns an empty result when there are no memories, snapshot, handoff or
 * recent events. */
export async function assembleContext(ctx: Context, opts: ContextOptions): Promise<ContextResult> {
  const budget = opts.budget ?? DEFAULT_CONTEXT_BUDGET;
  assertScopeRequestAllowed(ctx.actor, opts.exactScope);
  if (budget <= 0) return { entries: [], tokens: 0 };

  const plan = planContext(ctx, opts, sourceOf(ctx.store));
  const sections = await loadTaskSections(ctx, opts, plan, openBlockBudget(plan, opts, budget));
  const admission = ambientAdmission(opts, plan, sections.shownHandoff);
  const recallRequest = promptRecallRequest(opts, plan);
  const pools = await loadPools(ctx, { plan, admission, recallRequest, left: sections.left });
  const noSections =
    !sections.shownSnapshot && !sections.shownHandoff && sections.shownEvents.length === 0;
  if (nothingToInject(plan, pools, noSections)) return { entries: [], tokens: 0 };

  const picked = plan.pinnedOnly
    ? selectPinned({ opts, plan, left: sections.left, pools, admission })
    : plan.query === NO_QUERY
      ? selectStrongest(plan, sections.left, pools)
      : await selectBySearch(ctx, { plan, left: sections.left, pools, admission });
  if (picked === null) return { entries: [], tokens: 0 };

  const { items, tokens } = finalizeSelection(picked, plan);
  if (items.length === 0 && noSections) {
    // A query that found nothing is the coverage-gap signal, so it still gets a trace; pinned-only
    // stays read-only.
    if (!plan.pinnedOnly) await traceEmptyContext(ctx, opts, plan);
    return { entries: [], tokens: 0 };
  }

  // pinnedOnly is the UserPromptSubmit hot path: read-only so pinned memories don't inflate
  // retrieval_count or extend half_life every turn.
  const recorded = plan.pinnedOnly
    ? { items, ambientState: undefined }
    : await recordRetrieval(ctx, {
        opts,
        plan,
        selected: items,
        activeSnapshot: sections.activeSnapshot,
      });
  return contextResult(recorded, tokens, sections);
}

function contextResult(
  recorded: RecordedRetrieval,
  tokens: number,
  sections: TaskSections,
): ContextResult {
  return {
    entries: recorded.items,
    tokens,
    activeSnapshot: sections.shownSnapshot ?? undefined,
    sessionHandoff: sections.shownHandoff ?? undefined,
    recentEvents: sections.shownEvents.length > 0 ? sections.shownEvents : undefined,
    ambientState: recorded.ambientState,
  };
}

type AmbientPools = Awaited<ReturnType<typeof loadPools>>;

function nothingToInject(plan: ContextPlan, pools: AmbientPools, noSections: boolean): boolean {
  return (
    !plan.promptRecallPending &&
    pools.local.entries.length === 0 &&
    pools.global.entries.length === 0 &&
    noSections
  );
}

interface FinalSelection {
  items: ContextResultEntry[];
  tokens: number;
}

/** The `limit` cut, then the held-copy drop, then each entry's origin annotation. */
function finalizeSelection(picked: ContextResultEntry[], plan: ContextPlan): FinalSelection {
  const { obs } = plan;
  offerRanked(picked, plan);
  let selected = picked;
  if (plan.limit < selected.length) {
    const cut = selected.slice(0, plan.limit);
    obs?.dropMissing(
      selected.map((r) => r.entry),
      cut.map((r) => r.entry),
      'limit',
      'limit',
    );
    selected = cut;
  }
  // After the last cut, so a merged row that was cut hides nothing.
  const heldDropped = dropHeldCopies(selected, (r) => r.entry);
  obs?.dropMissing(
    selected.map((r) => r.entry),
    heldDropped.map((r) => r.entry),
    'limit',
    'duplicate',
  );
  selected = heldDropped;
  const tokens = selected.reduce((sum, r) => sum + r.tokens, 0);

  // Every returned entry carries its origin and how it relates to the active project, so renderers
  // can mark cross-project rows.
  selected = selected.map((r) => ({
    ...r,
    origin: r.entry.originProject ?? null,
    category: classifyOriginProject(r.entry.originProject, plan.currentProject),
  }));
  obs?.selected(selected);
  return { items: selected, tokens };
}

// Ranking reports nothing itself, so its results are offered here and the cuts after can name
// what they drop.
function offerRanked(picked: ContextResultEntry[], plan: ContextPlan): void {
  const { obs } = plan;
  if (plan.pinnedOnly || !obs) return;
  const pool = plan.query === NO_QUERY ? 'strength' : 'search';
  obs.offer(
    picked.filter((r) => r.isGlobal !== true).map((r) => r.entry),
    false,
    pool,
  );
  obs.offer(
    picked.filter((r) => r.isGlobal === true).map((r) => r.entry),
    true,
    pool,
  );
}

// Never touches the index, so it cannot desync last_retrieval_ids from last_trace_id.
async function traceEmptyContext(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
): Promise<void> {
  // No snapshot in this branch, so the caller's own id is the only session to stamp.
  const trace: RecallTraceInput = {
    tenantId: ctx.tenantId,
    sessionId: opts.currentSessionId || null,
    pipeline: 'context',
    query: plan.query,
    explainMode: false,
    results: [],
  };
  // The empty reply is already decided, so a lost trace is logged and the call still answers.
  try {
    await ctx.store.finishRecall({ goalLog: [], audit: [], trace });
  } catch (error) {
    rethrowIfStoreBlocked(error);
    log.error(`recall trace write failed: ${errorMessage(error)}`, errorFields(error));
  }
}

interface RecordedRetrieval {
  items: ContextResultEntry[];
  ambientState: AmbientState | undefined;
}

interface RecordRetrievalOptions {
  readonly opts: ContextOptions;
  readonly plan: ContextPlan;
  readonly selected: ContextResultEntry[];
  readonly activeSnapshot: TaskSnapshot | null;
}

/** Strengthens and marks the returned rows, then writes the trace and index together. */
async function recordRetrieval(
  ctx: Context,
  { opts, plan, selected, activeSnapshot }: RecordRetrievalOptions,
): Promise<RecordedRetrieval> {
  const toUpdate = selected.map((s) => s.entry);
  const updatedEntries = markRetrieved(toUpdate, plan.now, plan.strength);
  const retrievedIds = updatedEntries.map((u) => u.id);
  const trace: RecallTraceInput = {
    tenantId: ctx.tenantId,
    sessionId: opts.currentSessionId || activeSnapshot?.sessionId || null,
    pipeline: 'context',
    query: plan.query,
    explainMode: false,
    results: selected.map((s) => ({
      memoryId: s.entry.id,
      score: s.score,
    })),
  };
  const writes = { goalLog: [], audit: [], trace, strengthen: strengthenOf(ctx, retrievedIds) };
  // The last recall feeds only outcomeForLastRecall, so a store that keeps none still finishes the
  // recall without one.
  const store = ctx.store;
  const lastRecall = ctx.enrich?.lastRecall;
  const traceId = lastRecall
    ? await lastRecall.finishRecall(writes, plan.hasGlobal ? plan.globalRoot : undefined)
    : await store.finishRecall(writes).then(() => null);
  plan.obs?.traced(traceId);
  await store.bumpRecallStats(selected.length);

  // Replace selectedItems entries with markRetrieved-updated copies so the returned ContextResult
  // reflects post-recall state.
  const items = selected.map((s) => ({
    ...s,
    entry: updatedEntries.find((u) => u.id === s.entry.id) ?? s.entry,
  }));

  // Read after strengthenRetrieved commits, so the rows just retrieved count at their new strength.
  return {
    items,
    ambientState: plan.config.ambient.enabled ? await readAmbientState(ctx, plan) : undefined,
  };
}

async function readAmbientState(
  ctx: Context,
  plan: ContextPlan,
): Promise<AmbientState | undefined> {
  const filter = {
    exactScope: plan.exactScope,
    ownScope: plan.ownScope,
    project: plan.originProject,
    currentProject: projectNames(plan.currentProject),
    now: plan.now,
  };
  const sources = [
    ...(plan.hasLocal ? [plan.local.reads] : []),
    ...(plan.hasGlobal && !plan.primaryIsGlobal ? [globalSource(ctx).reads] : []),
  ];
  const tallies: AmbientTallies[] = [];
  for (const reads of sources) tallies.push(await reads.ambientTallies(ctx.tenantId, filter));
  const total = tallies.length > 0 ? tallies.reduce(addAmbientTallies) : undefined;
  return total && total.total > 0 ? ambientStateFromTallies(total) : undefined;
}
