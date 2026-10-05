// Ambient context injection: the admission policy and getContext.

import { isInitialized } from '../store/open.js';
import { strengthenRetrieved } from '../store/entry-writes.js';
import { loadRecallSearchEntries } from '../store/search-rows.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../store/rows.js';
import {
  loadAmbientCandidates,
  loadContextCandidates,
  type ContextCandidateFilter,
  type AmbientRecallRequest,
  type AmbientLoadResult,
  type RecentOrigins,
} from '../store/candidates.js';
import { loadIndex, saveIndex, updateStats } from '../store/index-and-stats.js';
import { loadFreshActiveTaskSnapshot, listSessionEvents, SNAPSHOT_AMBIENT_MAX_AGE_MS } from '../store/sessions.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import type { SessionHandoff } from '../handoff.js';
import { estimateTokens } from '../token-ledger.js';
import { markRetrieved, type MemoryEntry, COMPACTION_MEMORY_TAG } from '../memory.js';
import { isWorthSurfacing } from '../memory-quality.js';
import { getGlobalRoot } from '../shared.js';
import { writeRecallTraceAtRoot } from '../recall-trace.js';
import { evalNow, isRecallBoostAblated } from '../ablation.js';
import { dropHeldCopies } from '../same-text.js';
import { loadConfig } from '../config.js';
import { resolveProjectIdentity, classifyOriginProject, isGlobalStoreRoot, projectId, projectNames, type ProjectRef } from '../project-identity.js';
import { promptTokens } from '../prompt-recall.js';
import { detectSecret } from '../secret-detect.js';
import { isSessionDigestRow } from '../session-digest.js';
import { addAmbientTallies, ambientStateFromTallies, type AmbientState } from '../ambient.js';
import { loadAmbientTallies } from '../ambient-store.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed } from '../recall-scope.js';
import {
  finiteOr,
  selectBySearch,
  selectPinned,
  selectStrongest,
  type ContextAdmission,
  type ContextPlan,
  type ContextPools,
} from './context-select.js';
import type { ContextOpts, ContextResult, ContextResultEntry } from './context-types.js';
import type { Context } from './types.js';

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
  exactScope?: string,
): boolean {
  if (!ambientSecretAdmit(e, currentProject)) return false;
  if (!passesScopeFilterForRecall(e.scope ?? null, exactScope)) return false;
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
export const CONTEXT_CANDIDATE_CAP = 2000;

/** A query reads recall's FTS window from each store; the search's vector arm adds the nearest rows. */
interface ContextQueryWindow {
  query: string;
  exactScope: string | undefined;
  project: readonly string[] | undefined;
}

/** The pinned-only branch's recent-N backfill: how many rows, and the origins they may carry. */
interface RecentRequest {
  needed: number;
  origins: RecentOrigins | undefined;
}

// The pinned-only branch needs pins and recent-N candidates, not the corpus; `recent` and `recall` apply there only.
function loadAmbientEntries(
  hippoRoot: string,
  tenantId: string,
  pinnedOnly: boolean,
  recent: RecentRequest,
  admit: (e: MemoryEntry) => boolean,
  window: ContextCandidateFilter | ContextQueryWindow,
  recall?: AmbientRecallRequest,
  onQualityDrop?: (e: MemoryEntry) => void,
): AmbientLoadResult {
  if (!pinnedOnly) {
    const rows = 'query' in window
      ? loadRecallSearchEntries(hippoRoot, window.query, DEFAULT_SEARCH_CANDIDATE_LIMIT, tenantId, window.exactScope, 'exact', false, window.project)
      : loadContextCandidates(hippoRoot, tenantId, window);
    return { entries: rows.filter(admit) };
  }
  // The quality floor runs on the recent-N slice AFTER this load, so the load
  // counts by it too, or it stops short of a store whose newest rows are junk.
  const admitAmbient = (e: MemoryEntry): boolean => {
    if (!admit(e)) return false;
    if (e.pinned || isWorthSurfacing(e)) return true;
    onQualityDrop?.(e);
    return false;
  };
  return loadAmbientCandidates(hippoRoot, tenantId, recent.needed, admitAmbient, recall, recent.origins);
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

  const plan = planContext(ctx, opts);
  const sections = loadTaskSections(ctx, opts, plan, openBlockBudget(plan, opts, budget));
  const admission = ambientAdmission(opts, plan, sections.shownHandoff);
  const pools = loadPools(ctx, plan, admission, promptRecallRequest(opts, plan));
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
    if (!plan.pinnedOnly) traceEmptyContext(ctx, opts, plan.query);
    return { entries: [], tokens: 0 };
  }

  // pinnedOnly is the UserPromptSubmit hot path — read-only so pinned
  // memories don't inflate retrieval_count or extend half_life every turn.
  const recorded = plan.pinnedOnly
    ? { items, ambientState: undefined }
    : recordRetrieval(ctx, opts, plan, items, sections.activeSnapshot);

  return {
    entries: recorded.items,
    tokens,
    activeSnapshot: sections.shownSnapshot ?? undefined,
    sessionHandoff: sections.shownHandoff ?? undefined,
    recentEvents: sections.shownEvents.length > 0 ? sections.shownEvents : undefined,
    ambientState: recorded.ambientState,
  };
}

function planContext(ctx: Context, opts: ContextOpts): ContextPlan {
  const pinnedOnly = opts.pinnedOnly === true;
  // Global memories do not establish a project boundary for task state.
  const hasLocal = isInitialized(ctx.hippoRoot);
  const query = (opts.q ?? '').trim() || '*';
  const globalRoot = getGlobalRoot();
  const sharedStore = opts.sharedStore === true;
  // A store serving many people is not its operator's, so the operator's own global store stays out.
  const hasGlobal = !sharedStore && isInitialized(globalRoot);
  const primaryIsGlobal = isGlobalStoreRoot(ctx.hippoRoot);

  // opts.scope is only the tag boost, opts.exactScope the envelope request; other-project memories are
  // excluded unless the caller asks for them (crossProject) or isolation is disabled.
  const config = loadConfig(ctx.hippoRoot);
  const isolationEnabled = config.contextProjectIsolation !== false;
  const currentProject =
    opts.currentProject ?? resolveProjectIdentity(process.cwd());
  const includeCrossProject = opts.crossProject === true || !isolationEnabled;

  // Decided before the ambient loads so the pinned-only FTS candidate query can share their connection.
  const promptRecallPending = pinnedOnly && Boolean(opts.prompt?.trim()) && config.pinnedInject.promptRecall === true;

  const cost = opts.cost;
  const price = (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean): number => cost
    ? cost.entry({ entry, isGlobal, promptRecall, origin: entry.origin_project ?? null, category: classifyOriginProject(entry.origin_project, currentProject) })
    : estimateTokens(entry.content);
  return {
    pinnedOnly,
    limit: opts.limit ?? Number.POSITIVE_INFINITY,
    includeRecent: opts.includeRecent ?? 0,
    activeScope: opts.scope ?? '',
    exactScope: opts.exactScope || undefined,
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
    ? { terms: promptRecallTerms, limit: Math.floor(finiteOr(pinnedInject.promptRecallCandidates, 100, 1)) }
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
function loadRawTaskState(ctx: Context, opts: ContextOpts, plan: ContextPlan): RawTaskState {
  if (!plan.hasLocalTaskState) return NO_TASK_STATE;
  // Bounded read: an orphaned snapshot ages out of this ambient surface; the owner session's read stays unbounded.
  const snapshot = loadFreshActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, { sessionId: opts.currentSessionId });
  // On a shared store the task state is one person's, so it reaches only the session that saved it.
  if (plan.sharedStore && (!snapshot?.session_id || snapshot.session_id !== opts.currentSessionId)) return NO_TASK_STATE;
  const sessionId = snapshot?.session_id;
  const handoff = sessionId
    ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId)
    : loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, undefined, {
        unfinishedOnly: true,
        maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
        // Scope is admitted in SQL so a newer denied row can't hide an older eligible one before LIMIT 1.
        scopeFilter: 'default-deny',
      });
  // Raw session id here too: each event is admitted on its own scope, same as recall and the CLI.
  const events = sessionId ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: 5 }) : [];
  return { snapshot, handoff, events };
}

// Sections print ahead of the memories, so they are paid first; one that does not fit is dropped, as an oversize entry is.
function loadTaskSections(ctx: Context, opts: ContextOpts, plan: ContextPlan, startLeft: number): TaskSections {
  const { exactScope, cost } = plan;
  let left = startLeft;
  const pays = (tokens: number): boolean => {
    if (tokens > left) return false;
    left -= tokens;
    return true;
  };
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null => r?.scope ?? null;
  const raw = loadRawTaskState(ctx, opts, plan);
  // The same envelope rule ambientAdmitEntry applies to memory rows.
  const activeSnapshot = raw.snapshot && passesScopeFilterForRecall(rowScope(raw.snapshot), exactScope) ? raw.snapshot : null;
  const sessionHandoff = raw.handoff && passesScopeFilterForRecall(rowScope(raw.handoff), exactScope) ? raw.handoff : null;
  const recentSessionEvents = raw.events.filter((e) => passesScopeFilterForRecall(rowScope(e), exactScope));
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
  let digestHiddenForHandoff = false;
  const ambientAdmit = (e: MemoryEntry): boolean => {
    // A printed handoff already carries the session's closing message, which its digest would print a second time.
    if (transcriptHandoffSession !== null && e.source_session_id === transcriptHandoffSession && isSessionDigestRow(e)) {
      digestHiddenForHandoff = true;
      return false;
    }
    return ambientAdmitEntry(e, plan.currentProject, plan.includeCrossProject, plan.exactScope);
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
  return { ambientAdmit, admit, bothStoresAdmit, digestHidden: () => digestHiddenForHandoff };
}

/** Origins the recent backfill may read past its first window; on a shared store, only the caller's own project rows. */
function recentOrigins(plan: ContextPlan): RecentOrigins | undefined {
  if (plan.sharedStore) return { names: projectNames(plan.currentProject).filter((n) => n !== ''), userGlobal: false };
  return plan.originProject && { names: plan.originProject, userGlobal: true };
}

function loadPools(ctx: Context, plan: ContextPlan, admission: ContextAdmission, recallRequest: AmbientRecallRequest | undefined): ContextPools {
  const { obs, pinnedOnly, primaryIsGlobal, hasGlobal, exactScope } = plan;
  const recent: RecentRequest = { needed: plan.includeRecent, origins: recentOrigins(plan) };
  const searches = plan.query !== '*' && !pinnedOnly;
  const searchesBoth = searches && hasGlobal && !primaryIsGlobal;
  const poolAdmit = searchesBoth ? admission.bothStoresAdmit : admission.admit;
  const loadAdmit = obs ? obs.watchAdmit(poolAdmit) : poolAdmit;
  const qualityDrop = (isGlobal: boolean): ((e: MemoryEntry) => void) | undefined =>
    obs && !plan.promptRecallPending ? (e) => obs.qualityDropped(e, isGlobal) : undefined;

  // The window's predicates are ones admit applies anyway, so below the cap the admitted rows are unchanged.
  const window: ContextCandidateFilter | ContextQueryWindow = searches
    ? { query: plan.query, exactScope, project: plan.originProject }
    : {
        exactScope,
        project: plan.originProject,
        cap: CONTEXT_CANDIDATE_CAP,
        now: evalNow(),
      };
  // Tenant-scoped loads: never resolveTenantId({}) here.
  const local: AmbientLoadResult = plan.hasLocal
    ? loadAmbientEntries(ctx.hippoRoot, ctx.tenantId, pinnedOnly, recent, loadAdmit, window, recallRequest, qualityDrop(primaryIsGlobal))
    : { entries: [] };
  const global: AmbientLoadResult = hasGlobal && !primaryIsGlobal
    ? loadAmbientEntries(plan.globalRoot, ctx.tenantId, pinnedOnly, recent, loadAdmit, window, recallRequest, qualityDrop(true))
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

// Never touches the index, so it cannot desync last_retrieval_ids from last_trace_id; fail-soft, never throws.
function traceEmptyContext(ctx: Context, opts: ContextOpts, query: string): void {
  // No snapshot in this branch, so the caller's own id is the only session to stamp.
  writeRecallTraceAtRoot(ctx.hippoRoot, {
    tenantId: ctx.tenantId,
    sessionId: opts.currentSessionId || null,
    pipeline: 'context',
    query,
    explainMode: false,
    results: [],
  });
}

interface RecordedRetrieval {
  items: ContextResultEntry[];
  ambientState: AmbientState | undefined;
}

/** Strengthens and marks the returned rows, then writes the trace and index together. */
function recordRetrieval(
  ctx: Context,
  opts: ContextOpts,
  plan: ContextPlan,
  selected: ContextResultEntry[],
  activeSnapshot: TaskSnapshot | null,
): RecordedRetrieval {
  const toUpdate = selected.map((s) => s.entry);
  const updatedEntries = markRetrieved(toUpdate);
  const localIndex = loadIndex(ctx.hippoRoot);
  const retrievedIds = updatedEntries.map((u) => u.id);
  const strengthenedHere = strengthenRetrieved(ctx.hippoRoot, retrievedIds, { recallBoostAblated: isRecallBoostAblated() });
  if (plan.hasGlobal) strengthenRetrieved(plan.globalRoot, retrievedIds.filter((id) => !strengthenedHere.has(id)), { recallBoostAblated: isRecallBoostAblated() });

  localIndex.last_retrieval_ids = retrievedIds;

  // Trace first on its own short-lived connection, then fold its id into localIndex so one saveIndex moves
  // last_retrieval_ids and last_trace_id in lockstep; a failed trace write stores null, never a stale id.
  const traceId = writeRecallTraceAtRoot(ctx.hippoRoot, {
    tenantId: ctx.tenantId,
    sessionId: opts.currentSessionId || activeSnapshot?.session_id || null,
    pipeline: 'context',
    query: plan.query,
    explainMode: false,
    results: selected.map((s) => ({
      memoryId: s.entry.id,
      score: s.score,
    })),
  });
  localIndex.last_trace_id = traceId !== null ? String(traceId) : null;
  saveIndex(ctx.hippoRoot, localIndex);

  updateStats(ctx.hippoRoot, { recalled: selected.length });

  // Replace selectedItems entries with markRetrieved-updated copies so
  // the returned ContextResult reflects post-recall state.
  const items = selected.map((s) => ({
    ...s,
    entry: updatedEntries.find((u) => u.id === s.entry.id) ?? s.entry,
  }));

  // Read after strengthenRetrieved commits, so the rows just retrieved count at their new strength.
  return { items, ambientState: plan.config.ambient.enabled ? readAmbientState(ctx, plan) : undefined };
}

function readAmbientState(ctx: Context, plan: ContextPlan): AmbientState | undefined {
  const filter = { exactScope: plan.exactScope, project: plan.originProject, currentProject: projectNames(plan.currentProject), now: evalNow() };
  const roots = [...(plan.hasLocal ? [ctx.hippoRoot] : []), ...(plan.hasGlobal && !plan.primaryIsGlobal ? [plan.globalRoot] : [])];
  const tallies = roots.map((root) => loadAmbientTallies(root, ctx.tenantId, filter));
  const total = tallies.length > 0 ? tallies.reduce(addAmbientTallies) : undefined;
  return total && total.total > 0 ? ambientStateFromTallies(total) : undefined;
}

