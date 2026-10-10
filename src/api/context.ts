// Ambient context injection: the admission policy and getContext.

import { isInitialized } from '../store/open.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../store/rows.js';
import {
  type ContextCandidateFilter,
  type AmbientRecallRequest,
  type AmbientLoadResult,
  type RecentOrigins,
} from '../store/candidates.js';
import { type ContinuityKey, freshActiveSnapshot, SNAPSHOT_AMBIENT_MAX_AGE_MS } from '../store/sessions.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import type { SessionHandoff } from '../core/handoff.js';
import { estimateTokens } from '../util/token-text.js';
import { markRetrieved, type MemoryEntry, COMPACTION_MEMORY_TAG } from '../core/memory.js';
import { isWorthSurfacing } from '../core/memory-quality.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import type { RecallTraceInput } from '../store/recall-trace.js';
import { evalNow } from '../core/ablation.js';
import { dropHeldCopies } from '../util/same-text.js';
import { BadRequestError } from '../core/api-errors.js';
import { isSharedStore, loadConfig } from '../core/config.js';
import { rethrowIfSqliteBlocked } from '../db/index.js';
import { errorMessage, log } from '../util/log.js';
import { resolveProjectIdentity, classifyOriginProject, isGlobalStoreRoot, projectId, projectNames, type ProjectRef } from '../core/project-identity.js';
import { promptTokens } from '../core/prompt-recall.js';
import { detectSecret } from '../util/secret-detect.js';
import { isSessionDigestRow } from '../core/session-digest-row.js';
import { addAmbientTallies, ambientStateFromTallies, type AmbientState, type AmbientTallies } from '../core/ambient.js';
import { requireGroup, sqliteStore, storeFor, type HippoStore } from '../store/index.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed, personalScopeOf } from '../store/recall-scope.js';
import {
  finiteOr,
  selectBySearch,
  selectPinned,
  selectStrongest,
  type ContextAdmission,
  type ContextPlan,
  type ContextPools,
  type ContextSource,
} from './context-select.js';
import type { ContextOpts, ContextResult, ContextResultEntry } from './context-types.js';
import { andThen, onStore } from './on-store.js';
import { strengthenOf } from './recall-record.js';
import { type Context, ownerOrSubject } from './types.js';

export { oneCopyPerMemory } from './context-select.js';

/**
 * v39: the single ambient-injection admission policy, shared by getContext
 * and the CLI-side ambient-state summary so the two cannot drift.
 *
 * - Secret veto is UNCONDITIONAL: neither crossProject nor
 *   contextProjectIsolation:false re-includes secrets. A flagged row only
 *   injects inside its owning project; flagged rows with no project origin
 *   (''/null) never ambient-inject at all. Explicit recall is unaffected -
 *   recalling a secret is a deliberate act.
 * - Envelope parity: private/quarantine scopes never inject unless `exactScope` names one.
 * - Origin partition: other-project rows are excluded unless
 *   `includeCrossProject`.
 */
function ambientAdmitEntry(
  e: MemoryEntry,
  currentProject: ProjectRef,
  includeCrossProject: boolean,
  exactScope: string | undefined,
  own: string | undefined,
): boolean {
  if (!ambientSecretAdmit(e, currentProject)) return false;
  if (!passesScopeFilterForRecall(e.scope ?? null, exactScope, own)) return false;
  if (includeCrossProject) return true;
  return classifyOriginProject(e.origin_project, currentProject) !== 'cross-project';
}

/**
 * The secret half of the ambient policy on its own, for callers
 * that apply their own scope rule. A flagged row is only admitted inside its owning project;
 * flagged rows with no project origin never ambient-inject.
 */
export function ambientSecretAdmit(e: MemoryEntry, currentProject: ProjectRef): boolean {
  if (!detectSecret(e).flagged) return true;
  const origin = e.origin_project;
  if (origin === undefined || origin === null || origin === '') return false;
  return projectNames(currentProject).includes(origin);
}

/** Most rows per store a no-query context reads; past it, ranking and ambientState see the strongest by decay. */
const CONTEXT_CANDIDATE_CAP = 2000;

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

/** A store's base search and context reads; a store without the group throws StoreNotPortedError. */
function sourceOf(store: HippoStore): ContextSource {
  return { store, reads: requireGroup(store, 'contextReads') };
}

/** What one store's ambient read is asked for. `recent`, `recall` and `onQualityDrop` apply to the pinned-only branch alone. */
interface LoadAmbientEntriesOptions {
  readonly pinnedOnly: boolean;
  readonly recent: RecentRequest;
  readonly admit: (e: MemoryEntry) => boolean;
  /** `admit` without the delivery observer, so a row checked twice is not refused twice in the ledger. */
  readonly recheck: (e: MemoryEntry) => boolean;
  readonly window: ContextCandidateFilter | ContextQueryWindow;
  readonly recall?: AmbientRecallRequest;
  readonly onQualityDrop?: (e: MemoryEntry) => void;
}

// The pinned-only branch needs pins and recent-N candidates, not the corpus.
async function loadAmbientEntries(source: ContextSource, tenantId: string, options: LoadAmbientEntriesOptions): Promise<AmbientLoadResult> {
  const { pinnedOnly, recent, admit, recheck, window, recall, onQualityDrop } = options;
  const ownTenant = (e: MemoryEntry): boolean => e.tenantId === tenantId;
  if (!pinnedOnly) {
    const rows = 'query' in window
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
  // The quality floor runs on the recent-N slice AFTER this load, so the load
  // counts by it too, or it stops short of a store whose newest rows are junk.
  const admitAmbient = (e: MemoryEntry): boolean => {
    if (!admit(e)) return false;
    if (e.pinned || isWorthSurfacing(e)) return true;
    onQualityDrop?.(e);
    return false;
  };
  const loaded = await source.reads.ambientCandidates(tenantId, { recentNeeded: recent.needed, admit: admitAmbient, recall, origins: recent.origins });
  // Pins and recent rows reach core only through the store's own call to admit, so core applies it again with the tenant.
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

/**
 * Assemble a context bundle: recalled memories (pinned-only / strength-sorted
 * fallback / hybrid search) + active task snapshot + session handoff + recent
 * session events. Budget-bounded, tenant-scoped. Mutates `last_retrieval_ids`
 * + emits a 'recall' audit row for non-pinned, non-'*' queries.
 *
 * Behaves like the pre-extraction `cmdContext` data-loading + selection
 * pipeline. CLI presentation (markdown / json / additional-context rendering)
 * stays in `cli.ts`.
 *
 * Tenant scope: all `loadAllEntries` / snapshot / handoff / events reads use
 * `ctx.tenantId`. Cross-tenant rows are filtered out.
 *
 * @returns An empty result (`entries: []`, snapshot/handoff/events undefined)
 * when there's nothing to surface (no memories AND no snapshot AND no handoff
 * AND no recent events).
 */
export async function getContext(
  ctx: Context,
  opts: ContextOpts = {},
): Promise<ContextResult> {
  const budget = opts.budget ?? 1500;
  assertScopeRequestAllowed(ctx.actor, opts.exactScope);
  if (budget <= 0) {
    return { entries: [], tokens: 0 };
  }

  const plan = planContext(ctx, opts, sourceOf(storeFor(ctx)));
  const sections = await loadTaskSections(ctx, opts, plan, openBlockBudget(plan, opts, budget));
  const admission = ambientAdmission(opts, plan, sections.shownHandoff);
  const pools = await loadPools(ctx, plan, admission, promptRecallRequest(opts, plan));
  const noSections = !sections.shownSnapshot && !sections.shownHandoff && sections.shownEvents.length === 0;
  if (!plan.promptRecallPending && pools.local.entries.length === 0 && pools.global.entries.length === 0 && noSections) {
    return { entries: [], tokens: 0 };
  }

  const picked = plan.pinnedOnly
    ? selectPinned(opts, plan, sections.left, pools, admission)
    : plan.query === '*'
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

  // pinnedOnly is the UserPromptSubmit hot path — read-only so pinned
  // memories don't inflate retrieval_count or extend half_life every turn.
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

const isolationWarned = new Set<string>();

/** A laptop config copied onto a team store must not open every member's rows to every prompt, so the flag loses there. */
function warnIsolationIgnored(hippoRoot: string): void {
  if (isolationWarned.has(hippoRoot)) return;
  isolationWarned.add(hippoRoot);
  log.warn(`${hippoRoot}: "contextProjectIsolation": false is ignored on a shared store; a read opts in with cross_project.`);
}

/** Which stores this read can draw on, and what kind the primary one is. */
function storesInReach(ctx: Context, opts: ContextOpts, local: ContextSource) {
  const other = local.store.kind !== 'sqlite' ? local.store : undefined;
  // Global memories do not establish a project boundary for task state.
  const hasLocal = other !== undefined || isInitialized(ctx.hippoRoot);
  const globalRoot = getGlobalRoot();
  // The store's own flag counts too, so no surface can read a shared store as its owner.
  const sharedStore = opts.sharedStore === true || isSharedStore(ctx.hippoRoot);
  // A store serving many people is not its operator's, so the operator's own global store stays out.
  const hasGlobal = !sharedStore && other === undefined && isInitialized(globalRoot);
  const primaryIsGlobal = isGlobalStoreRoot(ctx.hippoRoot);
  return { other, hasLocal, globalRoot, sharedStore, hasGlobal, primaryIsGlobal };
}

/** Prices one entry against the budget: the caller's cost model when it gave one, else a token estimate. */
function entryPricer(cost: ContextOpts['cost'], currentProject: ContextPlan['currentProject']): ContextPlan['price'] {
  return (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean): number => cost
    ? cost.entry({ entry, isGlobal, promptRecall, origin: entry.origin_project ?? null, category: classifyOriginProject(entry.origin_project, currentProject) })
    : estimateTokens(entry.content);
}

function planContext(ctx: Context, opts: ContextOpts, local: ContextSource): ContextPlan {
  const pinnedOnly = opts.pinnedOnly === true;
  const { other, hasLocal, globalRoot, sharedStore, hasGlobal, primaryIsGlobal } = storesInReach(ctx, opts, local);
  const query = (opts.q ?? '').trim() || '*';

  // opts.scope is only the tag boost, opts.exactScope the envelope request; other-project memories are
  // excluded unless the caller asks for them (crossProject) or isolation is disabled.
  const config = loadConfig(ctx.hippoRoot);
  const isolationEnabled = config.contextProjectIsolation !== false;
  const currentProject =
    opts.currentProject ?? resolveProjectIdentity(process.cwd());
  // A caller with no project reads every row as its own; on a shared store those rows are other people's.
  if (sharedStore && projectId(currentProject).trim() === '') throw new BadRequestError('a shared store needs the caller\'s project');
  if (sharedStore && !isolationEnabled) warnIsolationIgnored(ctx.hippoRoot);
  const includeCrossProject = opts.crossProject === true || (!isolationEnabled && !sharedStore);

  // Decided before the ambient loads so the pinned-only FTS candidate query can share their connection.
  const promptRecallPending = pinnedOnly && Boolean(opts.prompt?.trim()) && config.pinnedInject.promptRecall === true;

  const cost = opts.cost;
  const price = entryPricer(cost, currentProject);
  return {
    local,
    other,
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
function promptRecallRequest(opts: ContextOpts, plan: ContextPlan): AmbientRecallRequest | undefined {
  const { pinnedInject } = plan.config;
  const promptRecallTerms = plan.promptRecallPending && pinnedInject.enabled
    ? Array.from(promptTokens(opts.prompt ?? ''))
    : [];
  return promptRecallTerms.length > 0
    ? { terms: promptRecallTerms, limit: Math.floor(finiteOr(pinnedInject.promptRecallCandidates, 100, 1)), ownScope: plan.ownScope }
    : undefined;
}

/** Reports the block's facts to the observer and returns the budget left after the fixed headers. */
function openBlockBudget(plan: ContextPlan, opts: ContextOpts, budget: number): number {
  const { config, cost, obs, pinnedOnly, promptRecallPending } = plan;
  const blockBudget = pinnedOnly && opts.budget === undefined ? config.pinnedInject.budget : budget;
  obs?.facts({ projectName: projectId(plan.currentProject), budgetTokens: blockBudget, promptRecall: promptRecallPending });
  if (pinnedOnly && !config.pinnedInject.enabled) obs?.disabled();
  return cost
    ? Math.max(0, blockBudget - cost.fixed(blockBudget, { cross: plan.includeCrossProject, promptRecall: promptRecallPending, ambient: !pinnedOnly && config.ambient.enabled }))
    : blockBudget;
}

interface RawTaskState {
  readonly snapshot: TaskSnapshot | null;
  readonly handoff: SessionHandoff | null;
  readonly events: readonly SessionEvent[];
}

const NO_TASK_STATE: RawTaskState = { snapshot: null, handoff: null, events: [] };

// Keyed on the RAW snapshot: a scope-hidden active session must not fall through to another session's ambient handoff.
async function loadRawTaskState(ctx: Context, opts: ContextOpts, plan: ContextPlan): Promise<RawTaskState> {
  if (!plan.hasLocalTaskState) return NO_TASK_STATE;
  const { store, reads } = plan.local;
  // On a shared store task state is one person's, keyed by owner and project so it follows them into their next session.
  const key: ContinuityKey | null = plan.sharedStore
    ? { owner: ownerOrSubject(ctx.actor), project: projectNames(plan.currentProject) }
    : null;
  const block = await store.continuity(ctx.tenantId, 5, key);
  // Bounded read: an orphaned snapshot ages out of this ambient surface; the owner session's read stays unbounded.
  const snapshot = freshActiveSnapshot(block.activeSnapshot, { sessionId: opts.currentSessionId });
  // The block's handoff and events are the raw snapshot's session's, so they stand only while that snapshot is fresh.
  if (snapshot?.session_id) return { snapshot, handoff: block.sessionHandoff, events: block.recentSessionEvents };
  // An unfinished handoff's scope is admitted in the read, so a newer denied row can't hide an older eligible one.
  return { snapshot, handoff: await reads.unfinishedHandoff(ctx.tenantId, SNAPSHOT_AMBIENT_MAX_AGE_MS, key), events: [] };
}

// Sections print ahead of the memories, so they are paid first; one that does not fit is dropped, as an oversize entry is.
async function loadTaskSections(ctx: Context, opts: ContextOpts, plan: ContextPlan, startLeft: number): Promise<TaskSections> {
  const { exactScope, ownScope, cost } = plan;
  let left = startLeft;
  const pays = (tokens: number): boolean => {
    if (tokens > left) return false;
    left -= tokens;
    return true;
  };
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null => r?.scope ?? null;
  const raw = await loadRawTaskState(ctx, opts, plan);
  // The same envelope rule ambientAdmitEntry applies to memory rows.
  const activeSnapshot = raw.snapshot && passesScopeFilterForRecall(rowScope(raw.snapshot), exactScope, ownScope) ? raw.snapshot : null;
  const sessionHandoff = raw.handoff && passesScopeFilterForRecall(rowScope(raw.handoff), exactScope, ownScope) ? raw.handoff : null;
  const recentSessionEvents = raw.events.filter((e) => passesScopeFilterForRecall(rowScope(e), exactScope, ownScope));
  const shownSnapshot = activeSnapshot && (!cost || pays(cost.snapshot(activeSnapshot))) ? activeSnapshot : null;
  const shownHandoff = sessionHandoff && (!cost || pays(cost.handoff(sessionHandoff))) ? sessionHandoff : null;
  const shownEvents = recentSessionEvents.length > 0 && (!cost || pays(cost.trail(recentSessionEvents))) ? recentSessionEvents : [];
  plan.obs?.sections(
    Number(shownSnapshot !== null) + Number(shownHandoff !== null) + Number(shownEvents.length > 0),
    Number(activeSnapshot !== shownSnapshot) + Number(sessionHandoff !== shownHandoff) + Number(recentSessionEvents.length !== shownEvents.length),
  );
  return { activeSnapshot, shownSnapshot, shownHandoff, shownEvents, left };
}

function ambientAdmission(opts: ContextOpts, plan: ContextPlan, shownHandoff: SessionHandoff | null): ContextAdmission {
  const transcriptHandoffSession = shownHandoff?.evidence?.derivedFrom === 'transcript' ? shownHandoff.sessionId : null;
  const ambientAdmit = (e: MemoryEntry): boolean => {
    // A printed handoff already carries the session's closing message, which its digest would print a second time.
    if (transcriptHandoffSession !== null && e.source_session_id === transcriptHandoffSession && isSessionDigestRow(e)) return false;
    return ambientAdmitEntry(e, plan.currentProject, plan.includeCrossProject, plan.exactScope, plan.ownScope);
  };
  const ownSessionId = opts.currentSessionId || '';
  // Inside admit, not after the load, so the loader's window widens past a session's own items.
  const isOwnCompactionItem = (e: MemoryEntry): boolean =>
    ownSessionId !== '' &&
    e.source_session_id === ownSessionId &&
    e.tags.includes(COMPACTION_MEMORY_TAG);
  // Superseded rows never inject; which rows reach ambientAdmitEntry matters because it regex-scans content for secrets.
  const admit = (e: MemoryEntry): boolean => !e.superseded_by && !isOwnCompactionItem(e) && ambientAdmit(e);
  // The two-store search has always ranked a session's own compaction items; only the local search drops them.
  const bothStoresAdmit = (e: MemoryEntry): boolean => !e.superseded_by && ambientAdmit(e);
  return { ambientAdmit, admit, bothStoresAdmit };
}

/** Origins the recent backfill may read past its first window; on a shared store, only the caller's own project rows. */
function recentOrigins(plan: ContextPlan): RecentOrigins | undefined {
  if (plan.sharedStore) return { names: projectNames(plan.currentProject).filter((n) => n !== ''), userGlobal: false };
  return plan.originProject && { names: plan.originProject, userGlobal: true };
}

async function loadPools(
  ctx: Context,
  plan: ContextPlan,
  admission: ContextAdmission,
  recallRequest: AmbientRecallRequest | undefined,
): Promise<ContextPools> {
  const { obs, pinnedOnly, primaryIsGlobal, hasGlobal, exactScope, ownScope } = plan;
  const recent: RecentRequest = { needed: plan.includeRecent, origins: recentOrigins(plan) };
  const searches = plan.query !== '*' && !pinnedOnly;
  const searchesBoth = searches && hasGlobal && !primaryIsGlobal;
  const poolAdmit = searchesBoth ? admission.bothStoresAdmit : admission.admit;
  const loadAdmit = obs ? obs.watchAdmit(poolAdmit) : poolAdmit;
  const qualityDrop = (isGlobal: boolean): ((e: MemoryEntry) => void) | undefined =>
    obs && !plan.promptRecallPending ? (e) => obs.qualityDropped(e, isGlobal) : undefined;

  // The window's predicates are ones admit applies anyway, so below the cap the admitted rows are unchanged.
  const window: ContextCandidateFilter | ContextQueryWindow = searches
    ? { query: plan.query, exactScope, ownScope, project: plan.originProject }
    : {
        exactScope,
        ownScope,
        project: plan.originProject,
        cap: CONTEXT_CANDIDATE_CAP,
        now: evalNow(),
      };
  // Tenant-scoped loads: never resolveTenantId({}) here.
  const read = { pinnedOnly, recent, admit: loadAdmit, recheck: poolAdmit, window, recall: recallRequest };
  const local: AmbientLoadResult = plan.hasLocal
    ? await loadAmbientEntries(plan.local, ctx.tenantId, { ...read, onQualityDrop: qualityDrop(primaryIsGlobal) })
    : { entries: [] };
  const global: AmbientLoadResult = hasGlobal && !primaryIsGlobal
    ? await loadAmbientEntries(sourceOf(sqliteStore(plan.globalRoot)), ctx.tenantId, { ...read, onQualityDrop: qualityDrop(true) })
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
  let selected = picked;
  if (plan.limit < selected.length) {
    const cut = selected.slice(0, plan.limit);
    obs?.dropMissing(selected.map((r) => r.entry), cut.map((r) => r.entry), 'limit', 'limit');
    selected = cut;
  }
  const heldDropped = dropHeldCopies(selected, (r) => r.entry); // after the last cut, so a merged row that was cut hides nothing
  obs?.dropMissing(selected.map((r) => r.entry), heldDropped.map((r) => r.entry), 'limit', 'duplicate');
  selected = heldDropped;
  const tokens = selected.reduce((sum, r) => sum + r.tokens, 0);

  // Every returned entry carries its origin and how it relates to the active project, so renderers can mark cross-project rows.
  selected = selected.map((r) => ({
    ...r,
    origin: r.entry.origin_project ?? null,
    category: classifyOriginProject(r.entry.origin_project, plan.currentProject),
  }));
  obs?.selected(selected);
  return { items: selected, tokens };
}

// Never touches the index, so it cannot desync last_retrieval_ids from last_trace_id.
async function traceEmptyContext(ctx: Context, opts: ContextOpts, plan: ContextPlan): Promise<void> {
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
    await onStore(ctx, (port) => port.finishRecall({ goalLog: [], audit: [], trace }));
  } catch (error) {
    rethrowIfSqliteBlocked(error);
    log.error(`recall trace write failed: ${errorMessage(error)}`);
  }
}

interface RecordedRetrieval {
  items: ContextResultEntry[];
  ambientState: AmbientState | undefined;
}

/** Strengthens and marks the returned rows, then writes the trace and index together. */
async function recordRetrieval(
  ctx: Context,
  opts: ContextOpts,
  plan: ContextPlan,
  selected: ContextResultEntry[],
  activeSnapshot: TaskSnapshot | null,
): Promise<RecordedRetrieval> {
  const toUpdate = selected.map((s) => s.entry);
  const updatedEntries = markRetrieved(toUpdate);
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
  // hippo.db keeps the ids as its last recall, which feeds only outcomeForLastRecall, and it alone reads a second root.
  await onStore(ctx, (port, local) => andThen(
    local.finishLastRecall(writes, plan.hasGlobal ? plan.globalRoot : undefined),
    () => port.bumpRecallStats(selected.length),
  ));

  // Replace selectedItems entries with markRetrieved-updated copies so
  // the returned ContextResult reflects post-recall state.
  const items = selected.map((s) => ({
    ...s,
    entry: updatedEntries.find((u) => u.id === s.entry.id) ?? s.entry,
  }));

  // Read after strengthenRetrieved commits, so the rows just retrieved count at their new strength.
  return { items, ambientState: plan.config.ambient.enabled ? await readAmbientState(ctx, plan) : undefined };
}

async function readAmbientState(ctx: Context, plan: ContextPlan): Promise<AmbientState | undefined> {
  const filter = { exactScope: plan.exactScope, ownScope: plan.ownScope, project: plan.originProject, currentProject: projectNames(plan.currentProject), now: evalNow() };
  const sources = [
    ...(plan.hasLocal ? [plan.local.reads] : []),
    ...(plan.hasGlobal && !plan.primaryIsGlobal ? [sourceOf(sqliteStore(plan.globalRoot)).reads] : []),
  ];
  const tallies: AmbientTallies[] = [];
  for (const reads of sources) tallies.push(await reads.ambientTallies(ctx.tenantId, filter));
  const total = tallies.length > 0 ? tallies.reduce(addAmbientTallies) : undefined;
  return total && total.total > 0 ? ambientStateFromTallies(total) : undefined;
}

