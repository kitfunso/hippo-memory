// Ambient context injection: the admission policy and contextGet.

import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../core/search-types.js';
import { freshActiveSnapshot, SNAPSHOT_AMBIENT_MAX_AGE_MS } from '../core/session-snapshot.js';
import type { SessionEvent, TaskSnapshot } from '../store/port/sessions.js';
import type { SessionHandoff } from '../core/handoff.js';
import { estimateTokens } from '../util/token-text.js';
import { markRetrieved, strengthOptionsOf, type MemoryEntry } from '../core/memory.js';
import { evalNow } from '../core/ablation.js';
import { dropHeldCopies } from '../util/same-text.js';
import { BadRequestError } from '../core/api-errors.js';
import { rethrowIfSqliteBlocked } from '../util/sqlite-blocked.js';
import { errorMessage, log, errorFields } from '../util/log.js';
import { classifyOriginProject, projectId, projectNames } from '../core/project-identity.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { promptTokens } from '../core/prompt-recall.js';
import { ambientAdmits, ambientEnvelopeAdmits, type AmbientAdmission } from '../core/read-admission.js';
import { addAmbientTallies, ambientStateFromTallies, type AmbientState, type AmbientTallies } from '../core/ambient.js';
import type { HippoStore } from '../store/port.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed, personalScopeOf } from '../core/recall-scope.js';
import {
  finiteOr,
  globalStoreInReach,
  selectBySearch,
  selectPinned,
  selectStrongest,
  type ContextAdmission,
  type ContextPlan,
  type ContextPools,
  type ContextSource,
} from './context-select.js';
import type { ContextOptions, ContextResult, ContextResultEntry } from './context-types.js';
import { strengthenOf } from './recall/finish.js';
import { tokenPurse } from './recall/render.js';
import { type Context, ownerOrSubject } from './types.js';
import type {
  ContextCandidateFilter,
  AmbientRecallRequest,
  AmbientLoadResult,
  AmbientRefusal,
  RecentOrigins,
} from '../store/port/context-reads.js';
import type { ContinuityKey } from '../store/port/types.js';
import type { RecallTraceInput } from '../store/port/recall-writes.js';
import type { StoreReach } from '../store/local/index.js';

export { oneCopyPerMemory } from './context-select.js';

/** Tokens a context block may use when the caller sets no budget; the hook command and the CLI default match it. */
export const DEFAULT_CONTEXT_BUDGET = 1500;

// The plan's query when the caller gave none: context then ranks by strength instead of searching.
export const NO_QUERY = '*';

/** Most rows per store a no-query context reads; past it, ranking sees the strongest by decay. */
const CONTEXT_CANDIDATE_CAP = 2000;
/** The page is sized from the rows the budget can pay for: a memory under this many tokens is rarer than the slack. */
const CONTEXT_PAGE_ROW_TOKENS = 20;
/** Strength also weighs recall count and valence, so the strongest rows by strength sit a few times deeper than their
 * decay rank; the page reads that many times the rows it can return. */
const CONTEXT_PAGE_SLACK = 4;
/** The smallest page, so a tiny budget or limit still ranks a real candidate set. */
const CONTEXT_PAGE_MIN = 200;

/** Rows per store a no-query context reads: the strongest by decay, enough to fill the budget and the limit. */
function contextCandidatePage(left: number, limit: number): number {
  const returnable = Math.min(Math.ceil(Math.max(0, left) / CONTEXT_PAGE_ROW_TOKENS), limit);
  return Math.min(CONTEXT_CANDIDATE_CAP, Math.max(CONTEXT_PAGE_MIN, Math.ceil(returnable * CONTEXT_PAGE_SLACK)));
}

/** A query reads recall's FTS window from each store; the search's vector arm adds the nearest rows. */
interface ContextQueryWindow {
  query: string;
  exactScope: string | undefined;
  ownScope: string | undefined;
  project: readonly string[] | undefined;
}

/** The pinned-only branch's recent-N backfill: how many rows, and the origins they may carry. */
interface RecentRequest {
  needed: number;
  origins: RecentOrigins | undefined;
}

/** A store's base search and context reads, both required on the port. */
function sourceOf(store: HippoStore): ContextSource {
  return { store, reads: store.contextReads };
}

/** What one store's ambient read is asked for. `recent`, `admission`, `recall` and `onRefused` apply to the pinned-only
 * branch alone. */
interface LoadAmbientEntriesOptions {
  readonly pinnedOnly: boolean;
  readonly recent: RecentRequest;
  readonly admit: (e: MemoryEntry) => boolean;
  /** `admit` without the delivery observer, so a row checked twice is not refused twice in the ledger. */
  readonly recheck: (e: MemoryEntry) => boolean;
  /** `recheck` as data, which the store applies in the pinned-only load. */
  readonly admission: AmbientAdmission;
  readonly window: ContextCandidateFilter | ContextQueryWindow;
  readonly recall?: AmbientRecallRequest;
  readonly onRefused?: (refusal: AmbientRefusal) => void;
}

// The pinned-only branch needs pins and recent-N candidates, not the corpus.
async function loadAmbientEntries(
  source: ContextSource,
  tenantId: string,
  options: LoadAmbientEntriesOptions,
): Promise<AmbientLoadResult> {
  const { pinnedOnly, recent, admit, recheck, admission, window, recall, onRefused } = options;
  const ownTenant = (e: MemoryEntry): boolean => e.tenantId === tenantId;
  if (!pinnedOnly) {
    const rows =
      'query' in window
        ? await source.store.searchRecallEntries(window.query, {
            limit: DEFAULT_SEARCH_CANDIDATE_LIMIT,
            tenantId,
            requestedScope: window.exactScope,
            explicitScopeMode: 'exact',
            includeSuperseded: false,
            originProjects: window.project,
            ownScope: window.ownScope,
          })
        : await source.reads.contextCandidates(tenantId, window);
    return { entries: rows.filter((e) => ownTenant(e) && admit(e)) };
  }
  // The store applies the quality floor too, or its recent-N load stops short of a store whose newest rows are junk.
  const loaded = await source.reads.ambientCandidates(tenantId, {
    recentNeeded: recent.needed,
    admit: admission,
    recall,
    origins: recent.origins,
  });
  if (onRefused) for (const refusal of loaded.refused) onRefused(refusal);
  // Pins and recent rows reach core only through the store's own call to admit, so core applies it again with the
  // tenant.
  const entries = loaded.entries.filter((e) => ownTenant(e) && recheck(e));
  return loaded.recall ? { entries, recall: loaded.recall.filter(ownTenant) } : { entries };
}

/** The task-state sections printed ahead of the memories, and the budget left once they are paid. */
interface TaskSections {
  activeSnapshot: TaskSnapshot | null;
  shownSnapshot: TaskSnapshot | null;
  shownHandoff: SessionHandoff | null;
  shownEvents: SessionEvent[];
  left: number;
}

/** Assembles a budget-bounded, tenant-scoped context bundle; mutates `last_retrieval_ids` and emits a 'recall' audit
 * row for non-pinned, non-'*' queries. Returns an empty result when there are no memories, snapshot, handoff or recent
 * events. CLI rendering stays in `cli.ts`. */
export async function contextGet(ctx: Context, opts: ContextOptions): Promise<ContextResult> {
  const budget = opts.budget ?? DEFAULT_CONTEXT_BUDGET;
  assertScopeRequestAllowed(ctx.actor, opts.exactScope);
  if (budget <= 0) {
    return { entries: [], tokens: 0 };
  }

  const plan = planContext(ctx, opts, sourceOf(ctx.store));
  const sections = await loadTaskSections(ctx, opts, plan, openBlockBudget(plan, opts, budget));
  const admission = ambientAdmission(opts, plan, sections.shownHandoff);
  const pools = await loadPools(ctx, plan, admission, promptRecallRequest(opts, plan), sections.left);
  const noSections = !sections.shownSnapshot && !sections.shownHandoff && sections.shownEvents.length === 0;
  if (nothingToInject(plan, pools, noSections)) {
    return { entries: [], tokens: 0 };
  }

  const picked = plan.pinnedOnly
    ? selectPinned(opts, plan, sections.left, pools, admission)
    : plan.query === NO_QUERY
      ? selectStrongest(plan, sections.left, pools)
      : await selectBySearch(ctx, plan, sections.left, pools, admission);
  if (picked === null) {
    return { entries: [], tokens: 0 };
  }

  const { items, tokens } = finalizeSelection(picked, plan);
  if (items.length === 0 && noSections) {
    // A query that found nothing is the coverage-gap signal, so it still gets a trace; pinned-only stays read-only.
    if (!plan.pinnedOnly) await traceEmptyContext(ctx, opts, plan);
    return { entries: [], tokens: 0 };
  }

  // pinnedOnly is the UserPromptSubmit hot path: read-only so pinned memories don't inflate retrieval_count or extend
  // half_life every turn.
  const recorded = plan.pinnedOnly
    ? { items, ambientState: undefined }
    : await recordRetrieval(ctx, opts, plan, items, sections.activeSnapshot);

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
    !plan.promptRecallPending && pools.local.entries.length === 0 && pools.global.entries.length === 0 && noSections
  );
}

const isolationWarned = new Set<string>();

/**
 * A laptop config copied onto a team store must not open every member's rows to every prompt, so the flag loses there.
 */
function warnIsolationIgnored(hippoRoot: string): void {
  if (isolationWarned.has(hippoRoot)) return;
  isolationWarned.add(hippoRoot);
  log.warn(
    `${hippoRoot}: "contextProjectIsolation": false is ignored on a shared store; a read opts in with cross_project.`,
  );
}

/** Which stores this read can draw on, and what kind the primary one is. */
function storesInReach(ctx: Context, opts: ContextOptions) {
  // No reach means an integrator's own store: one project, no global store beside it.
  const reach: StoreReach = ctx.reach ?? { hasLocal: true, isGlobal: false, shared: ctx.config.sharedStore };
  // The store's own flag counts too, so no surface can read a shared store as its owner.
  const sharedStore = opts.sharedStore === true || reach.shared;
  // A store serving many people is not its operator's, so the operator's own global store stays out; the root sets
  // `global` only beside hippo.db.
  const hasGlobal = !sharedStore && reach.global !== undefined;
  // Global memories do not establish a project boundary for task state.
  return {
    hasLocal: reach.hasLocal,
    globalRoot: reach.global?.root ?? '',
    sharedStore,
    hasGlobal,
    primaryIsGlobal: reach.isGlobal,
  };
}

function globalSource(ctx: Context): ContextSource {
  return sourceOf(globalStoreInReach(ctx));
}

/** Prices one entry against the budget: the caller's cost model when it gave one, else a token estimate. */
function entryPricer(
  cost: ContextOptions['cost'],
  currentProject: ContextPlan['currentProject'],
): ContextPlan['price'] {
  return (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean): number =>
    cost
      ? cost.entry({
          entry,
          isGlobal,
          promptRecall,
          origin: entry.originProject ?? null,
          category: classifyOriginProject(entry.originProject, currentProject),
        })
      : estimateTokens(entry.content);
}

function planContext(ctx: Context, opts: ContextOptions, local: ContextSource): ContextPlan {
  const pinnedOnly = opts.pinnedOnly === true;
  const { hasLocal, globalRoot, sharedStore, hasGlobal, primaryIsGlobal } = storesInReach(ctx, opts);
  const query = (opts.q ?? '').trim() || NO_QUERY;

  // opts.scope is only the tag boost, opts.exactScope the envelope request; other-project memories are excluded unless
  // the caller asks for them (crossProject) or isolation is disabled.
  const config = ctx.config;
  const isolationEnabled = config.contextProjectIsolation !== false;
  const currentProject = opts.currentProject;
  // A caller with no project reads every row as its own; on a shared store those rows are other people's.
  if (sharedStore && projectId(currentProject).trim() === '') {
    throw new BadRequestError("a shared store needs the caller's project");
  }
  if (sharedStore && !isolationEnabled) warnIsolationIgnored(ctx.hippoRoot);
  const includeCrossProject = opts.crossProject === true || (!isolationEnabled && !sharedStore);

  // Decided before the ambient loads so the pinned-only FTS candidate query can share their connection.
  const promptRecallPending = pinnedOnly && Boolean(opts.prompt?.trim()) && config.pinnedInject.promptRecall === true;

  const cost = opts.cost;
  const price = entryPricer(cost, currentProject);
  return {
    local,
    pinnedOnly,
    limit: opts.limit ?? Number.POSITIVE_INFINITY,
    includeRecent: opts.includeRecent ?? 0,
    activeScope: opts.scope ?? '',
    exactScope: opts.exactScope || undefined,
    ownScope: personalScopeOf(ctx.actor) ?? undefined,
    query,
    hasLocal,
    hasGlobal,
    globalRoot,
    primaryIsGlobal,
    hasLocalTaskState: hasLocal && !primaryIsGlobal,
    sharedStore,
    config,
    currentProject,
    includeCrossProject,
    originProject: includeCrossProject || projectId(currentProject) === '' ? undefined : projectNames(currentProject),
    promptRecallPending,
    cost,
    price,
    obs: opts.deliveryObserver,
  };
}

/** The prompt-recall candidate request the ambient loads carry, when the prompt has any terms. */
function promptRecallRequest(opts: ContextOptions, plan: ContextPlan): AmbientRecallRequest | undefined {
  const { pinnedInject } = plan.config;
  const promptRecallTerms =
    plan.promptRecallPending && pinnedInject.enabled ? Array.from(promptTokens(opts.prompt ?? '')) : [];
  return promptRecallTerms.length > 0
    ? {
        terms: promptRecallTerms,
        limit: Math.floor(
          finiteOr(pinnedInject.promptRecallCandidates, DEFAULT_CONFIG.pinnedInject.promptRecallCandidates, 1),
        ),
        ownScope: plan.ownScope,
      }
    : undefined;
}

/** Reports the block's facts to the observer and returns the budget left after the fixed headers. */
function openBlockBudget(plan: ContextPlan, opts: ContextOptions, budget: number): number {
  const { config, cost, obs, pinnedOnly, promptRecallPending } = plan;
  const blockBudget = pinnedOnly && opts.budget === undefined ? config.pinnedInject.budget : budget;
  obs?.facts({
    projectName: projectId(plan.currentProject),
    budgetTokens: blockBudget,
    promptRecall: promptRecallPending,
  });
  if (pinnedOnly && !config.pinnedInject.enabled) obs?.disabled();
  if (!pinnedOnly) obs?.queried(plan.query);
  return cost
    ? Math.max(
        0,
        blockBudget -
          cost.fixed(blockBudget, {
            cross: plan.includeCrossProject,
            promptRecall: promptRecallPending,
            ambient: !pinnedOnly && config.ambient.enabled,
          }),
      )
    : blockBudget;
}

interface RawTaskState {
  readonly snapshot: TaskSnapshot | null;
  readonly handoff: SessionHandoff | null;
  readonly events: readonly SessionEvent[];
}

const NO_TASK_STATE: RawTaskState = { snapshot: null, handoff: null, events: [] };

// Keyed on the RAW snapshot: a scope-hidden active session must not fall through to another session's ambient handoff.
async function loadRawTaskState(ctx: Context, opts: ContextOptions, plan: ContextPlan): Promise<RawTaskState> {
  if (!plan.hasLocalTaskState) return NO_TASK_STATE;
  const { store, reads } = plan.local;
  // On a shared store task state is one person's, keyed by owner and project so it follows them into their next
  // session.
  const key: ContinuityKey | null = plan.sharedStore
    ? { owner: ownerOrSubject(ctx.actor), project: projectNames(plan.currentProject) }
    : null;
  const block = await store.continuity(ctx.tenantId, 5, key);
  // Bounded read: an orphaned snapshot ages out of this ambient surface; the owner session's read stays unbounded.
  const snapshot = freshActiveSnapshot(block.activeSnapshot, { sessionId: opts.currentSessionId });
  // The block's handoff and events are the raw snapshot's session's, so they stand only while that snapshot is fresh.
  if (snapshot?.session_id) return { snapshot, handoff: block.sessionHandoff, events: block.recentSessionEvents };
  // An unfinished handoff's scope is admitted in the read, so a newer denied row can't hide an older eligible one.
  return {
    snapshot,
    handoff: await reads.unfinishedHandoff(ctx.tenantId, SNAPSHOT_AMBIENT_MAX_AGE_MS, key),
    events: [],
  };
}

// Sections print ahead of the memories, so they are paid first; one that does not fit is dropped, as an oversize entry
// is.
async function loadTaskSections(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
  startLeft: number,
): Promise<TaskSections> {
  const { exactScope, ownScope, cost } = plan;
  const { pays, left } = tokenPurse(startLeft);
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null => r?.scope ?? null;
  const raw = await loadRawTaskState(ctx, opts, plan);
  // The same envelope rule ambientAdmitEntry applies to memory rows.
  const activeSnapshot =
    raw.snapshot && passesScopeFilterForRecall(rowScope(raw.snapshot), exactScope, ownScope) ? raw.snapshot : null;
  const sessionHandoff =
    raw.handoff && passesScopeFilterForRecall(rowScope(raw.handoff), exactScope, ownScope) ? raw.handoff : null;
  const recentSessionEvents = raw.events.filter((e) => passesScopeFilterForRecall(rowScope(e), exactScope, ownScope));
  const shownSnapshot = activeSnapshot && (!cost || pays(cost.snapshot(activeSnapshot))) ? activeSnapshot : null;
  const shownHandoff = sessionHandoff && (!cost || pays(cost.handoff(sessionHandoff))) ? sessionHandoff : null;
  const shownEvents =
    recentSessionEvents.length > 0 && (!cost || pays(cost.trail(recentSessionEvents))) ? recentSessionEvents : [];
  plan.obs?.sections(
    Number(shownSnapshot !== null) + Number(shownHandoff !== null) + Number(shownEvents.length > 0),
    Number(activeSnapshot !== shownSnapshot) +
      Number(sessionHandoff !== shownHandoff) +
      Number(recentSessionEvents.length !== shownEvents.length),
  );
  return { activeSnapshot, shownSnapshot, shownHandoff, shownEvents, left: left() };
}

function ambientAdmission(
  opts: ContextOptions,
  plan: ContextPlan,
  shownHandoff: SessionHandoff | null,
): ContextAdmission {
  const rule: AmbientAdmission = {
    currentProject: plan.currentProject,
    includeCrossProject: plan.includeCrossProject,
    exactScope: plan.exactScope,
    ownScope: plan.ownScope,
    // Inside admit, not after the load, so the loader's window widens past a session's own items.
    ownSessionId: opts.currentSessionId || undefined,
    handoffSessionId: shownHandoff?.evidence?.derivedFrom === 'transcript' ? shownHandoff.sessionId : undefined,
  };
  const admit = (e: MemoryEntry): boolean => ambientAdmits(e, rule);
  // The two-store search has always ranked a session's own compaction items; only the local search drops them.
  const bothStoresAdmit = (e: MemoryEntry): boolean => !e.supersededBy && ambientEnvelopeAdmits(e, rule);
  return { rule, admit, bothStoresAdmit };
}

/**
 * Origins the recent backfill may read past its first window; on a shared store, only the caller's own project rows.
 */
function recentOrigins(plan: ContextPlan): RecentOrigins | undefined {
  if (plan.sharedStore) return { names: projectNames(plan.currentProject).filter((n) => n !== ''), userGlobal: false };
  return plan.originProject && { names: plan.originProject, userGlobal: true };
}

async function loadPools(
  ctx: Context,
  plan: ContextPlan,
  admission: ContextAdmission,
  recallRequest: AmbientRecallRequest | undefined,
  left: number,
): Promise<ContextPools> {
  const { obs, pinnedOnly, primaryIsGlobal, hasGlobal, exactScope, ownScope } = plan;
  const recent: RecentRequest = { needed: plan.includeRecent, origins: recentOrigins(plan) };
  const searches = plan.query !== NO_QUERY && !pinnedOnly;
  const searchesBoth = searches && hasGlobal && !primaryIsGlobal;
  const poolAdmit = searchesBoth ? admission.bothStoresAdmit : admission.admit;
  const loadAdmit = obs ? obs.watchAdmit(poolAdmit) : poolAdmit;
  // With prompt recall on, eligibility reports a row the quality floor drops.
  const refusedBy = (isGlobal: boolean): ((refusal: AmbientRefusal) => void) | undefined =>
    obs &&
    ((r) => {
      if (r.reason === 'admission') obs.filtered(r.id);
      else if (!plan.promptRecallPending) obs.qualityDropped(r.id, isGlobal);
    });

  // The window's predicates are ones admit applies anyway, so below the cap the admitted rows are unchanged.
  const window: ContextCandidateFilter | ContextQueryWindow = searches
    ? { query: plan.query, exactScope, ownScope, project: plan.originProject }
    : {
        exactScope,
        ownScope,
        project: plan.originProject,
        cap: contextCandidatePage(left, plan.limit),
        now: evalNow(),
      };
  // Tenant-scoped loads: never resolveTenantId({}) here.
  const read = {
    pinnedOnly,
    recent,
    admit: loadAdmit,
    recheck: poolAdmit,
    admission: admission.rule,
    window,
    recall: recallRequest,
  };
  const local: AmbientLoadResult = plan.hasLocal
    ? await loadAmbientEntries(plan.local, ctx.tenantId, { ...read, onRefused: refusedBy(primaryIsGlobal) })
    : { entries: [] };
  const global: AmbientLoadResult =
    hasGlobal && !primaryIsGlobal
      ? await loadAmbientEntries(globalSource(ctx), ctx.tenantId, { ...read, onRefused: refusedBy(true) })
      : { entries: [] };
  return { local, global };
}

interface FinalSelection {
  items: ContextResultEntry[];
  tokens: number;
}

/** The `limit` cut, then the held-copy drop, then each entry's origin annotation. */
function finalizeSelection(picked: ContextResultEntry[], plan: ContextPlan): FinalSelection {
  const { obs } = plan;
  // Ranking reports nothing itself, so its results are offered here and the cuts below can name what they drop.
  if (!plan.pinnedOnly && obs) {
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

  // Every returned entry carries its origin and how it relates to the active project, so renderers can mark
  // cross-project rows.
  selected = selected.map((r) => ({
    ...r,
    origin: r.entry.originProject ?? null,
    category: classifyOriginProject(r.entry.originProject, plan.currentProject),
  }));
  obs?.selected(selected);
  return { items: selected, tokens };
}

// Never touches the index, so it cannot desync last_retrieval_ids from last_trace_id.
async function traceEmptyContext(ctx: Context, opts: ContextOptions, plan: ContextPlan): Promise<void> {
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
    rethrowIfSqliteBlocked(error);
    log.error(`recall trace write failed: ${errorMessage(error)}`, errorFields(error));
  }
}

interface RecordedRetrieval {
  items: ContextResultEntry[];
  ambientState: AmbientState | undefined;
}

/** Strengthens and marks the returned rows, then writes the trace and index together. */
async function recordRetrieval(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
  selected: ContextResultEntry[],
  activeSnapshot: TaskSnapshot | null,
): Promise<RecordedRetrieval> {
  const toUpdate = selected.map((s) => s.entry);
  const updatedEntries = markRetrieved(toUpdate, undefined, strengthOptionsOf(ctx.config.runtime));
  const retrievedIds = updatedEntries.map((u) => u.id);
  const trace: RecallTraceInput = {
    tenantId: ctx.tenantId,
    sessionId: opts.currentSessionId || activeSnapshot?.session_id || null,
    pipeline: 'context',
    query: plan.query,
    explainMode: false,
    results: selected.map((s) => ({
      memoryId: s.entry.id,
      score: s.score,
    })),
  };
  const writes = { goalLog: [], audit: [], trace, strengthen: strengthenOf(ctx, retrievedIds) };
  // The last recall feeds only outcomeForLastRecall, so a store that keeps none still finishes the recall without one.
  const store = ctx.store;
  const traceId = store.lastRecall
    ? await store.lastRecall.finishRecall(writes, plan.hasGlobal ? plan.globalRoot : undefined)
    : await store.finishRecall(writes).then(() => null);
  plan.obs?.traced(traceId);
  await store.bumpRecallStats(selected.length);

  // Replace selectedItems entries with markRetrieved-updated copies so the returned ContextResult reflects post-recall
  // state.
  const items = selected.map((s) => ({
    ...s,
    entry: updatedEntries.find((u) => u.id === s.entry.id) ?? s.entry,
  }));

  // Read after strengthenRetrieved commits, so the rows just retrieved count at their new strength.
  return { items, ambientState: plan.config.ambient.enabled ? await readAmbientState(ctx, plan) : undefined };
}

async function readAmbientState(ctx: Context, plan: ContextPlan): Promise<AmbientState | undefined> {
  const filter = {
    exactScope: plan.exactScope,
    ownScope: plan.ownScope,
    project: plan.originProject,
    currentProject: projectNames(plan.currentProject),
    now: evalNow(),
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
