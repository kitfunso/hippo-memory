// Ambient context injection: the admission policy and getContext.

import { openHippoDb, closeHippoDb } from '../db.js';
import { isInitialized } from '../store/open.js';
import { strengthenRetrieved } from '../store/entry-writes.js';
import { loadRecallSearchEntries, recallScopeFilter } from '../store/search-rows.js';
import {
  loadAmbientCandidates,
  loadContextCandidates,
  type ContextCandidateFilter,
  type AmbientRecallRequest,
  type AmbientLoadResult,
} from '../store/candidates.js';
import { loadIndex, saveIndex, updateStats } from '../store/index-and-stats.js';
import { loadFreshActiveTaskSnapshot, listSessionEvents, SNAPSHOT_AMBIENT_MAX_AGE_MS } from '../store/sessions.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import { estimateTokens } from '../token-ledger.js';
import { calculateStrength, markRetrieved, type MemoryEntry, COMPACTION_MEMORY_TAG } from '../memory.js';
import { appendAuditEvent, auditQueryFields, isContentWorthStoring } from '../audit.js';
import { getGlobalRoot, searchBothHybrid } from '../shared.js';
import { writeRecallTraceAtRoot } from '../recall-trace.js';
import { evalNow, isRecallBoostAblated } from '../ablation.js';
import { hybridSearch } from '../search/hybrid.js';
import { physicsSearch } from '../search/physics-search.js';
import type { HybridVectorCandidates } from '../search/vector.js';
import type { SearchResult } from '../search/types.js';
import { compareScoredResults } from '../compare.js';
import { dropHeldCopies } from '../same-text.js';
import { scopeMatch } from '../scope.js';
import { loadConfig } from '../config.js';
import { resolveProjectIdentity, classifyOriginProject, isGlobalStoreRoot } from '../project-identity.js';
import {
  promptTokens,
  contentTokens,
  gatePromptRecall,
  type PromptRecallMetric,
  type PromptRecallGate,
} from '../prompt-recall.js';
import { detectSecret } from '../secret-detect.js';
import { isSessionDigestRow } from '../session-digest.js';
import { addAmbientTallies, ambientStateFromTallies, type AmbientState } from '../ambient.js';
import { loadAmbientTallies } from '../ambient-store.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed } from '../recall-scope.js';
import type { ContextOpts, ContextResult, ContextResultEntry } from './context-types.js';
import type { Context } from './types.js';

/**
 * v39: the single ambient-injection admission policy, shared by getContext
 * and the CLI-side ambient-state summary so the two cannot drift.
 *
 * - S4 secret veto is UNCONDITIONAL: neither crossProject nor
 *   contextProjectIsolation:false re-includes secrets. A flagged row only
 *   injects inside its owning project; flagged rows with no project origin
 *   (''/null) never ambient-inject at all. Explicit recall is unaffected -
 *   recalling a secret is a deliberate act.
 * - S2 envelope parity: private/quarantine scopes never inject unless `exactScope` names one.
 * - S3 origin partition: other-project rows are excluded unless
 *   `includeCrossProject`.
 */
function ambientAdmitEntry(
  e: MemoryEntry,
  currentProjectName: string,
  includeCrossProject: boolean,
  exactScope?: string,
): boolean {
  if (!ambientSecretAdmit(e, currentProjectName)) return false;
  if (!passesScopeFilterForRecall(e.scope ?? null, exactScope)) return false;
  if (includeCrossProject) return true;
  return classifyOriginProject(e.origin_project, currentProjectName) !== 'cross-project';
}

/**
 * v39 S4: the secret half of the ambient policy on its own, for callers
 * that apply their own scope rule. A flagged row is only admitted inside its owning project;
 * flagged rows with no project origin never ambient-inject.
 */
export function ambientSecretAdmit(e: MemoryEntry, currentProjectName: string): boolean {
  if (!detectSecret(e).flagged) return true;
  const origin = e.origin_project;
  if (origin === undefined || origin === null || origin === '') return false;
  return origin === currentProjectName;
}

/** Most rows per store a no-query context reads; past it, ranking and ambientState see the strongest by decay. */
export const CONTEXT_CANDIDATE_CAP = 2000;

/** A local-only query reads its FTS window; the search's vector arm adds the nearest rows. */
interface ContextQueryWindow {
  query: string;
  exactScope: string | undefined;
}

// The pinned-only branch needs pins and recent-N candidates, not the corpus; `recall` applies there only.
function loadAmbientEntries(
  hippoRoot: string,
  tenantId: string,
  pinnedOnly: boolean,
  includeRecent: number,
  admit: (e: MemoryEntry) => boolean,
  window: ContextCandidateFilter | ContextQueryWindow,
  recall?: AmbientRecallRequest,
  onQualityDrop?: (e: MemoryEntry) => void,
): AmbientLoadResult {
  if (!pinnedOnly) {
    const rows = 'query' in window
      ? loadRecallSearchEntries(hippoRoot, window.query, CONTEXT_CANDIDATE_CAP, tenantId, window.exactScope, 'exact', false)
      : loadContextCandidates(hippoRoot, tenantId, window);
    return { entries: rows.filter(admit) };
  }
  // DF3's quality floor runs on the recent-N slice AFTER this load, so the load
  // counts by it too, or it stops short of a store whose newest rows are junk.
  const admitAmbient = (e: MemoryEntry): boolean => {
    if (!admit(e)) return false;
    if (e.pinned || isContentWorthStoring(e.content)) return true;
    onQualityDrop?.(e);
    return false;
  };
  return loadAmbientCandidates(hippoRoot, tenantId, includeRecent, admitAmbient, recall);
}

// Share and promote copy a memory to the global store under a new id, so equal content is the only link.
// A pinned copy wins, then the stronger one after the ranking's own global discount; a tie keeps the local copy.
export function oneCopyPerMemory(
  local: readonly MemoryEntry[],
  global: readonly MemoryEntry[],
  now: Date,
): [MemoryEntry[], MemoryEntry[]] {
  const score = (e: MemoryEntry, isGlobal: boolean): number => calculateStrength(e, now) * (isGlobal ? 1 / 1.2 : 1);
  const best = new Map<string, { entry: MemoryEntry; isGlobal: boolean }>();
  const offer = (entry: MemoryEntry, isGlobal: boolean): void => {
    const held = best.get(entry.content);
    const wins = !held || (held.entry.pinned !== entry.pinned
      ? entry.pinned
      : score(entry, isGlobal) > score(held.entry, held.isGlobal));
    if (wins) best.set(entry.content, { entry, isGlobal });
  };
  for (const e of local) offer(e, false);
  for (const e of global) offer(e, true);
  const kept = new Set([...best.values()].map((b) => b.entry));
  return [local.filter((e) => kept.has(e)), global.filter((e) => kept.has(e))];
}

const finiteOr = (v: number, dflt: number, min: number): number =>
  Number.isFinite(v) && v >= min ? v : dflt;

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
 * Returns an empty result (`entries: []`, snapshot/handoff/events undefined)
 * when there's nothing to surface (no memories AND no snapshot AND no handoff
 * AND no recent events).
 */
export async function getContext(
  ctx: Context,
  opts: ContextOpts = {},
): Promise<ContextResult> {
  const pinnedOnly = opts.pinnedOnly === true;
  const budget = opts.budget ?? 1500;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const includeRecent = opts.includeRecent ?? 0;
  const activeScope = opts.scope ?? '';
  assertScopeRequestAllowed(ctx.actor, opts.exactScope);
  const exactScope = opts.exactScope || undefined;

  if (budget <= 0) {
    return { entries: [], tokens: 0 };
  }

  // Global memories do not establish a project boundary for task state.
  const hasLocal = isInitialized(ctx.hippoRoot);

  const query = (opts.q ?? '').trim() || '*';

  const globalRoot = getGlobalRoot();
  const hasGlobal = isInitialized(globalRoot);
  const primaryIsGlobal = isGlobalStoreRoot(ctx.hippoRoot);
  const hasLocalTaskState = hasLocal && !primaryIsGlobal;

  // v39 memory scope isolation (docs/plans/2026-07-01-memory-scope-isolation.md).
  // S2: envelope-filter parity with api.recall; opts.scope is only the tag boost, opts.exactScope the envelope request.
  // S3: origin partition - other-project memories are excluded unless the
  // caller explicitly asks for them (crossProject) or isolation is disabled.
  const config = loadConfig(ctx.hippoRoot);
  const isolationEnabled = config.contextProjectIsolation !== false;
  const currentProjectName =
    opts.currentProject ?? resolveProjectIdentity(process.cwd()).name;
  const includeCrossProject = opts.crossProject === true || !isolationEnabled;

  // Z1: decided before the ambient loads so the FTS candidate query below (pinned-only
  // branch) can piggyback on that connection instead of opening its own.
  const promptRecallPending = pinnedOnly && Boolean(opts.prompt?.trim()) && config.pinnedInject.promptRecall === true;
  const promptRecallTerms = promptRecallPending && config.pinnedInject.enabled
    ? Array.from(promptTokens(opts.prompt ?? ''))
    : [];
  const recallRequest: AmbientRecallRequest | undefined =
    promptRecallTerms.length > 0
      ? { terms: promptRecallTerms, limit: Math.floor(finiteOr(config.pinnedInject.promptRecallCandidates, 100, 1)) }
      : undefined;

  const cost = opts.cost;
  const price = (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean): number => cost
    ? cost.entry({ entry, isGlobal, promptRecall, origin: entry.origin_project ?? null, category: classifyOriginProject(entry.origin_project, currentProjectName) })
    : estimateTokens(entry.content);
  const blockBudget = pinnedOnly && opts.budget === undefined ? config.pinnedInject.budget : budget;
  const obs = opts.deliveryObserver;
  obs?.facts({ projectName: currentProjectName, budgetTokens: blockBudget, promptRecall: promptRecallPending });
  if (pinnedOnly && !config.pinnedInject.enabled) obs?.disabled();
  let left = cost
    ? Math.max(0, blockBudget - cost.fixed(blockBudget, { cross: includeCrossProject, promptRecall: promptRecallPending, ambient: !pinnedOnly && config.ambient.enabled }))
    : blockBudget;
  // Sections print ahead of the memories, so they are paid first; one that does not fit is dropped, as an oversize entry is.
  const pays = (tokens: number): boolean => {
    if (tokens > left) return false;
    left -= tokens;
    return true;
  };

  // DF1 T2: bounded read — an orphaned snapshot (no later pre-compact
  // superseded it, no session-end closed it) must age out of this ambient
  // surface instead of injecting into every future prompt forever. Owner
  // reads (opts.currentSessionId matches the snapshot's session_id) stay
  // unbounded; see loadFreshActiveTaskSnapshot's own doc comment for the
  // exact null/empty-id matching rules.
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null => r?.scope ?? null;
  const rawActiveSnapshot = hasLocalTaskState
    ? loadFreshActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, {
        sessionId: opts.currentSessionId,
      })
    : null;
  // W1: the same envelope rule ambientAdmitEntry applies to memory rows.
  const activeSnapshot =
    rawActiveSnapshot && passesScopeFilterForRecall(rowScope(rawActiveSnapshot), exactScope)
      ? rawActiveSnapshot
      : null;
  // Key on the RAW snapshot: a scope-hidden active session must not fall through to another session's ambient handoff.
  const rawSessionHandoff = !hasLocalTaskState
    ? null
    : rawActiveSnapshot?.session_id
      ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, rawActiveSnapshot.session_id)
      : loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, undefined, {
          unfinishedOnly: true,
          maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
          // codex P2: admit scope in SQL so a newer denied row can't hide an older eligible one before LIMIT 1.
          scopeFilter: 'default-deny',
        });
  const sessionHandoff =
    rawSessionHandoff && passesScopeFilterForRecall(rowScope(rawSessionHandoff), exactScope)
      ? rawSessionHandoff
      : null;
  // Raw session id here too: each event is admitted on its own scope, same as recall and the CLI.
  const recentSessionEvents = hasLocalTaskState && rawActiveSnapshot?.session_id
    ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, {
        session_id: rawActiveSnapshot.session_id,
        limit: 5,
      }).filter((e) => passesScopeFilterForRecall(rowScope(e), exactScope))
    : [];
  const shownSnapshot = activeSnapshot && (!cost || pays(cost.snapshot(activeSnapshot))) ? activeSnapshot : null;
  const shownHandoff = sessionHandoff && (!cost || pays(cost.handoff(sessionHandoff))) ? sessionHandoff : null;
  const shownEvents = recentSessionEvents.length > 0 && (!cost || pays(cost.trail(recentSessionEvents))) ? recentSessionEvents : [];
  obs?.sections(
    Number(shownSnapshot !== null) + Number(shownHandoff !== null) + Number(shownEvents.length > 0),
    Number(activeSnapshot !== shownSnapshot) + Number(sessionHandoff !== shownHandoff) + Number(recentSessionEvents.length !== shownEvents.length),
  );

  const transcriptHandoffSession = shownHandoff?.evidence?.derivedFrom === 'transcript' ? shownHandoff.sessionId : null;
  let digestHiddenForHandoff = false;
  const ambientAdmit = (e: MemoryEntry): boolean => {
    // A printed handoff already carries the session's closing message, which its digest would print a second time.
    if (transcriptHandoffSession !== null && e.source_session_id === transcriptHandoffSession && isSessionDigestRow(e)) {
      digestHiddenForHandoff = true;
      return false;
    }
    return ambientAdmitEntry(e, currentProjectName, includeCrossProject, exactScope);
  };
  const ownSessionId = opts.currentSessionId || '';
  // Inside admit, not after the load, so the loader's window widens past a session's own items.
  const isOwnCompactionItem = (e: MemoryEntry): boolean =>
    ownSessionId !== '' &&
    e.source_session_id === ownSessionId &&
    e.tags.includes(COMPACTION_MEMORY_TAG);
  // Superseded rows never inject; which rows reach ambientAdmitEntry matters because it regex-scans content for secrets.
  const admit = (e: MemoryEntry): boolean => !e.superseded_by && !isOwnCompactionItem(e) && ambientAdmit(e);
  const loadAdmit = obs ? obs.watchAdmit(admit) : admit;
  const qualityDrop = (isGlobal: boolean): ((e: MemoryEntry) => void) | undefined =>
    obs && !promptRecallPending ? (e) => obs.qualityDropped(e, isGlobal) : undefined;

  // The window's predicates are ones admit applies anyway, so below the cap the admitted rows are unchanged.
  const searchesLocalRows = query !== '*' && !(hasGlobal && !primaryIsGlobal);
  const originProject = includeCrossProject || currentProjectName === '' ? undefined : currentProjectName;
  const window: ContextCandidateFilter | ContextQueryWindow = searchesLocalRows && !pinnedOnly
    ? { query, exactScope }
    : {
        exactScope,
        project: originProject,
        cap: CONTEXT_CANDIDATE_CAP,
        now: evalNow(),
      };
  // Tenant-scoped loads (v1.11.1 lesson: NEVER resolveTenantId({}) here).
  const localLoad: AmbientLoadResult = hasLocal
    ? loadAmbientEntries(ctx.hippoRoot, ctx.tenantId, pinnedOnly, includeRecent, loadAdmit, window, recallRequest, qualityDrop(primaryIsGlobal))
    : { entries: [] };
  const globalLoad: AmbientLoadResult = hasGlobal && !primaryIsGlobal
    ? loadAmbientEntries(globalRoot, ctx.tenantId, pinnedOnly, includeRecent, loadAdmit, window, recallRequest, qualityDrop(true))
    : { entries: [] };
  let localEntries = localLoad.entries;
  let globalEntries = globalLoad.entries;

  // Computed after markRetrieved runs, so avgStrength reflects post-retrieval strengths.
  let ambientState: AmbientState | undefined;

  if (
    !promptRecallPending &&
    localEntries.length === 0 &&
    globalEntries.length === 0 &&
    !shownSnapshot &&
    !shownHandoff &&
    shownEvents.length === 0
  ) {
    return { entries: [], tokens: 0 };
  }

  let selectedItems: ContextResultEntry[] = [];
  let totalTokens = 0;

  if (pinnedOnly) {
    // loadConfig is safe even when local isn't initialised — returns defaults.
    const pinnedCfg = loadConfig(ctx.hippoRoot);
    if (!pinnedCfg.pinnedInject.enabled) {
      return { entries: [], tokens: 0 };
    }
    // Effective budget: explicit opts.budget wins over config, less what the sections took.
    const effBudget = left;
    const nowP = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
    obs?.offer(localEntries, primaryIsGlobal);
    obs?.offer(globalEntries, true);
    const [localPool, globalPool] = oneCopyPerMemory(localEntries, globalEntries, nowP);
    obs?.dropMissing([...localEntries, ...globalEntries], [...localPool, ...globalPool], 'load', 'duplicate');
    const selectedIds = new Set<string>();
    let usedP = 0;

    // Pinned entries are explicit user intent, the recent-N list an automatic
    // backfill. Both loops share ONE budget and the recent loop runs first, so
    // pins are ranked here and reserve their share before it can spend.
    const pinnedLocal = localPool.filter((e) => e.pinned);
    const pinnedGlobal = globalPool.filter((e) => e.pinned);
    const rankedPinned = [
      ...pinnedLocal.map((e) => ({ entry: e, isGlobal: primaryIsGlobal })),
      ...pinnedGlobal.map((e) => ({ entry: e, isGlobal: true })),
    ]
      .map(({ entry, isGlobal }) => {
        const scopeSig = scopeMatch(entry.tags, activeScope);
        const sBst = scopeSig === 1 ? 1.5 : scopeSig === -1 ? 0.5 : 1.0;
        return {
          entry,
          score: calculateStrength(entry, nowP) * (isGlobal ? 1 / 1.2 : 1) * sBst,
          tokens: price(entry, isGlobal),
          isGlobal,
        };
      })
      .sort(compareScoredResults);

    // Mirror the pinned admission loop's own `continue`-not-`break`
    // semantics (further down) so the reserve equals what that loop will
    // actually admit -- a big pin near the front should not block smaller
    // pins behind it from reserving their share too.
    // Dedupe by id: `syncGlobalToLocal` copies global rows into the local
    // store preserving `entry.id`, so a synced pin appears in BOTH
    // `pinnedLocal` and `pinnedGlobal` and would otherwise reserve its cost
    // twice. The admission loop already dedupes via `selectedIds`; the
    // reserve has to mirror that or it silently starves recents of budget a
    // single returned pin never needed.
    let pinnedReserve = 0;
    const reservedIds = new Set<string>();
    for (const r of rankedPinned) {
      if (reservedIds.has(r.entry.id)) continue;
      if (pinnedReserve + r.tokens <= effBudget) {
        pinnedReserve += r.tokens;
        reservedIds.add(r.entry.id);
      }
    }
    // Known, accepted tradeoff: a pin that also lands in the recent-N slice
    // is counted once in `pinnedReserve` (here) AND admitted again by the
    // recent loop below, so a little budget goes unused (`recentBudget` is
    // more conservative than it needs to be in that case). That only
    // under-fills recents slightly -- it never displaces a pin -- so it is
    // the safe direction and is not worth extra bookkeeping to recover.
    const recentBudget = Math.max(0, effBudget - pinnedReserve);

    // Z1: gate the backfill on the prompt instead of recency (docs/plans/2026-09-26-z1-prompt-recall.md).
    const promptRecallOn = promptRecallPending;
    if (promptRecallOn) {
      const rawMetric = pinnedCfg.pinnedInject.promptRecallMetric;
      const metric: PromptRecallMetric = rawMetric === 'cosine' ? 'cosine' : 'jaccard';
      const gate: PromptRecallGate = {
        metric,
        threshold: finiteOr(pinnedCfg.pinnedInject.promptRecallThreshold, 0.04, 0),
        minShared: finiteOr(pinnedCfg.pinnedInject.promptRecallMinShared, 2, 0),
        maxItems: finiteOr(pinnedCfg.pinnedInject.promptRecallMaxItems, 5, 1),
      };
      const p = promptTokens(opts.prompt ?? '');
      if (p.size > 0) {
        // Candidates came off the ambient load's own connection (recallRequest above), not a fresh open.
        // A candidate carrying a pin's text would inject that memory a second time.
        const pinnedText = new Set(rankedPinned.map((r) => r.entry.content));
        const ineligibleReason = (e: MemoryEntry): 'scope' | 'pinned' | 'quality' | 'duplicate' | null =>
          !admit(e) ? 'scope'
            : e.pinned ? 'pinned'
              : !isContentWorthStoring(e.content) ? 'quality'
                : pinnedText.has(e.content) ? 'duplicate'
                  : null;
        const eligible = (e: MemoryEntry): boolean => {
          const why = ineligibleReason(e);
          if (why !== null && why !== 'pinned') obs?.reject(e, 'eligible', why);
          return why === null;
        };
        obs?.offer(localLoad.recall ?? [], primaryIsGlobal, 'prompt-recall');
        obs?.offer(globalLoad.recall ?? [], true, 'prompt-recall');
        const localEligible = (localLoad.recall ?? []).filter(eligible);
        const globalEligible = (globalLoad.recall ?? []).filter(eligible);
        const [localCandidates, globalCandidates] = oneCopyPerMemory(localEligible, globalEligible, nowP);
        obs?.dropMissing([...localEligible, ...globalEligible], [...localCandidates, ...globalCandidates], 'eligible', 'duplicate');
        const seenCandidateIds = new Set<string>();
        const candidateItems: Array<{ id: string; tokens: Set<string>; entry: MemoryEntry; isGlobal: boolean }> = [];
        // Local wins the id collision (a global row synced into the local store).
        for (const e of localCandidates) {
          if (seenCandidateIds.has(e.id)) continue;
          seenCandidateIds.add(e.id);
          candidateItems.push({ id: e.id, tokens: contentTokens(e.content), entry: e, isGlobal: primaryIsGlobal });
        }
        for (const e of globalCandidates) {
          if (seenCandidateIds.has(e.id)) continue;
          seenCandidateIds.add(e.id);
          candidateItems.push({ id: e.id, tokens: contentTokens(e.content), entry: e, isGlobal: true });
        }
        const gated = gatePromptRecall(p, candidateItems, gate);
        obs?.gated(p, candidateItems, gate, gated);
        for (const g of gated) {
          if (selectedIds.has(g.item.id)) continue;
          const tokens = price(g.item.entry, g.item.isGlobal, true);
          if (usedP + tokens > recentBudget) {
            obs?.reject(g.item.entry, 'budget', 'budget', g.score, tokens);
            continue;
          }
          selectedItems.push({ entry: g.item.entry, score: g.score, tokens, isGlobal: g.item.isGlobal, promptRecall: true });
          selectedIds.add(g.item.id);
          usedP += tokens;
        }
      }
    } else if (includeRecent > 0) {
      const recent = [
        ...localPool.map((entry) => ({ entry, isGlobal: primaryIsGlobal })),
        ...globalPool.map((entry) => ({ entry, isGlobal: true })),
      ]
        // T2 (src/compare.ts) note: this already carries an explicit
        // per-instance tiebreak (created desc -> id localeCompare) and is
        // deliberately left as-is rather than routed through
        // compareEntryIdentity. `created` reflects ingest order, so it is
        // cross-ingest stable at ms granularity; the residual is honest,
        // not silently ignored — rows created in the same millisecond fall
        // to `id.localeCompare`, which is per-instance random (id is
        // crypto.randomUUID()), so this listing is per-instance-
        // deterministic but NOT cross-ingest-stable under same-ms
        // collisions.
        .sort((a, b) => {
          const byCreated = Date.parse(b.entry.created) - Date.parse(a.entry.created);
          return byCreated !== 0 ? byCreated : b.entry.id.localeCompare(a.entry.id);
        })
        // DF3 (docs/plans/2026-08-23-df3-include-recent-quality-floor.md):
        // filter before slice, not after — the caller asked for N recent
        // *useful* entries, so a junk row must be skipped and backfilled
        // past, not counted against the N. Skip-only: no mutation, no audit
        // row, nothing becomes unrecoverable.
        //
        // `entry.pinned ||` bypass IS needed here (codex review finding,
        // corrects the earlier claim in this comment that it wasn't): under
        // budget pressure, a pinned entry that fails the heuristic gets
        // dropped from this recent slice, and an unpinned entry backfills
        // into its slot and consumes `usedP` in the loop below. By the time
        // the pinned block runs (further down), the budget it needed is
        // already spent, so it hits `continue` and the pinned entry is
        // omitted entirely — the pinned block is NOT a safety net once the
        // recent loop has already spent the shared budget.
        .filter(({ entry }) => entry.pinned || isContentWorthStoring(entry.content))
        .slice(0, includeRecent)
        .map(({ entry, isGlobal }) => ({
          entry,
          score: calculateStrength(entry, nowP) * (isGlobal ? 1 / 1.2 : 1),
          tokens: price(entry, isGlobal),
          isGlobal,
        }));

      for (const r of recent) {
        if (selectedIds.has(r.entry.id)) continue;
        if (usedP + r.tokens > recentBudget) {
          obs?.reject(r.entry, 'budget', 'budget', r.score, r.tokens);
          continue;
        }
        selectedItems.push(r);
        selectedIds.add(r.entry.id);
        usedP += r.tokens;
      }
    }

    if (
      pinnedLocal.length === 0 &&
      pinnedGlobal.length === 0 &&
      selectedItems.length === 0 &&
      !digestHiddenForHandoff
    ) {
      return { entries: [], tokens: 0 };
    }

    for (const r of rankedPinned) {
      if (selectedIds.has(r.entry.id)) continue;
      if (usedP + r.tokens > effBudget) {
        obs?.reject(r.entry, 'budget', 'budget', r.score, r.tokens);
        continue;
      }
      selectedItems.push(r);
      selectedIds.add(r.entry.id);
      usedP += r.tokens;
    }
    totalTokens = usedP;
  } else if (query === '*') {
    // No query: return strongest memories by strength, up to budget.
    const now = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
    const [localPool, globalPool] = oneCopyPerMemory(localEntries, globalEntries, now);
    const localRanked = localPool
      .map((e) => ({
        entry: e,
        score: calculateStrength(e, now),
        tokens: price(e, primaryIsGlobal),
        isGlobal: primaryIsGlobal,
      }))
      .sort(compareScoredResults);

    const globalRanked = globalPool
      .map((e) => ({
        entry: e,
        score: calculateStrength(e, now) * (1 / 1.2),
        tokens: price(e, true),
        isGlobal: true,
      }))
      .sort(compareScoredResults);

    const combined = [...localRanked, ...globalRanked].sort(compareScoredResults);

    let used = 0;
    for (const r of combined) {
      if (used + r.tokens > left) continue;
      selectedItems.push(r);
      used += r.tokens;
    }
    totalTokens = used;
  } else {
    // Real query: hybrid search (global + local) or physics+hybrid (local only).
    let results: ContextResultEntry[];
    const minResults = cost ? 0 : undefined; // a priced block skips an oversize top hit too, so the budget bounds it
    if (hasGlobal && !primaryIsGlobal) {
      // searchBothHybrid loads from the store roots itself, so the ambient
      // filter above never saw its candidates. Admission runs INSIDE the
      // search via the opt-in entryFilter, BEFORE ranking, cross-store
      // content-dedupe, and budgeting - a post-filter instead would let an
      // excluded row saturate the budget (codex rounds 1+3) or shadow its
      // admitted duplicate in the dedupe pass (codex round 4). Recall paths
      // never set entryFilter, so their behavior is unchanged.
      const localIndex = loadIndex(ctx.hippoRoot);
      const isGlobalHit = (e: MemoryEntry): boolean => !localIndex.entries[e.id];
      const merged = await searchBothHybrid(query, ctx.hippoRoot, globalRoot, {
        budget: left,
        minResults,
        cost: cost && ((r) => price(r.entry, isGlobalHit(r.entry))),
        scope: activeScope,
        tenantId: ctx.tenantId,
        entryFilter: ambientAdmit,
      });
      results = merged.map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: price(r.entry, isGlobalHit(r.entry)),
        isGlobal: isGlobalHit(r.entry),
      }));
    } else {
      const ctxConfig = loadConfig(ctx.hippoRoot);
      const usePhysicsCtx = ctxConfig.physics?.enabled !== false;
      const localCost = cost && ((r: SearchResult) => price(r.entry, primaryIsGlobal));
      const vectorCandidates: HybridVectorCandidates = {
        tenantId: ctx.tenantId, scope: recallScopeFilter(exactScope, 'exact'), includeSuperseded: false, admit,
      };
      const ctxResults = usePhysicsCtx
        ? await physicsSearch(query, localEntries, {
            budget: left,
            minResults,
            cost: localCost,
            hippoRoot: ctx.hippoRoot,
            physicsConfig: ctxConfig.physics,
            scope: activeScope,
            vectorCandidates,
          })
        : await hybridSearch(query, localEntries, {
            budget: left,
            minResults,
            cost: localCost,
            hippoRoot: ctx.hippoRoot,
            scope: activeScope,
            vectorCandidates,
          });
      results = ctxResults.map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: price(r.entry, primaryIsGlobal),
        isGlobal: primaryIsGlobal,
      }));
    }

    selectedItems = results;
    totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);

    // A5 H4: emit recall audit row for context-mode searches (matches the
    // 'recall' op emitted by api.recall for parity). pinnedOnly + '*' fallback
    // never hit the search engines, so they don't emit (matches cmdContext).
    const ctxRecallMetadata = {
      ...auditQueryFields(query),
      results: selectedItems.length,
      mode: 'context',
    };
    if (hasLocal) {
      const localDb = openHippoDb(ctx.hippoRoot);
      try {
        appendAuditEvent(localDb, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall',
          metadata: ctxRecallMetadata,
        });
      } finally {
        closeHippoDb(localDb);
      }
    }
    if (hasGlobal && !primaryIsGlobal) {
      const globalDb = openHippoDb(globalRoot);
      try {
        appendAuditEvent(globalDb, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall',
          metadata: ctxRecallMetadata,
        });
      } finally {
        closeHippoDb(globalDb);
      }
    }
  }

  if (limit < selectedItems.length) {
    const cut = selectedItems.slice(0, limit);
    obs?.dropMissing(selectedItems.map((r) => r.entry), cut.map((r) => r.entry), 'limit', 'limit');
    selectedItems = cut;
  }
  const heldDropped = dropHeldCopies(selectedItems, (r) => r.entry); // after the last cut, so a merged row that was cut hides nothing
  obs?.dropMissing(selectedItems.map((r) => r.entry), heldDropped.map((r) => r.entry), 'limit', 'duplicate');
  selectedItems = heldDropped;
  totalTokens = selectedItems.reduce((sum, r) => sum + r.tokens, 0);

  // v39: annotate every returned entry with its origin and how it relates to
  // the active project, so renderers can demarcate cross-project inclusions.
  selectedItems = selectedItems.map((r) => ({
    ...r,
    origin: r.entry.origin_project ?? null,
    category: classifyOriginProject(r.entry.origin_project, currentProjectName),
  }));
  obs?.selected(selectedItems);

  if (
    selectedItems.length === 0 &&
    !shownSnapshot &&
    !shownHandoff &&
    shownEvents.length === 0
  ) {
    // LC1 F5 fix: this bare early-return used to skip tracing entirely — a
    // query that found nothing is exactly the coverage-gap signal Track LC
    // needs. Write an empty trace (result_count 0, no result rows) so it
    // lands in the training corpus. Never touches localIndex/
    // last_retrieval_ids/last_trace_id — by construction it can't desync
    // (mirrors the CLI zero-result path). Skipped under pinnedOnly (hot
    // path stays read-only, same reason it skips markRetrieved). Fail-soft
    // internally; never throws.
    if (!pinnedOnly) {
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
    return { entries: [], tokens: 0 };
  }

  // pinnedOnly is the UserPromptSubmit hot path — read-only so pinned
  // memories don't inflate retrieval_count or extend half_life by 2 days per
  // turn over a long session.
  if (!pinnedOnly) {
    const toUpdate = selectedItems.map((s) => s.entry);
    const updatedEntries = markRetrieved(toUpdate);
    const localIndex = loadIndex(ctx.hippoRoot);
    const retrievedIds = updatedEntries.map((u) => u.id);
    const gate = { recallBoostAblated: isRecallBoostAblated() };
    const strengthenedHere = strengthenRetrieved(ctx.hippoRoot, retrievedIds, gate);
    if (hasGlobal) strengthenRetrieved(globalRoot, retrievedIds.filter((id) => !strengthenedHere.has(id)), gate);

    localIndex.last_retrieval_ids = retrievedIds;

    // LC1 F1 structural fix (docs/plans/2026-08-02-lc1-recall-trace-persistence.md):
    // write the trace FIRST — post-limit, post-annotation `selectedItems`
    // actually returned, on a fresh short-lived connection (the audit
    // handles above ~2410 are already closed by this point, matching this
    // block's own per-call-handle convention: writeEntry, saveIndex) — then
    // fold the resulting id into `localIndex` so the SAME `saveIndex` call
    // below persists last_retrieval_ids + last_trace_id atomically.
    // LOCKSTEP INVARIANT: last_trace_id must only ever advance together
    // with last_retrieval_ids; a two-connection stamp-then-clear design
    // could desync them on a crash between writes. A failed trace write
    // (traceId null) sets last_trace_id to null rather than leaving the
    // OLD id pointing at ids that are about to be overwritten. Fail-soft
    // internally; never throws.
    const traceId = writeRecallTraceAtRoot(ctx.hippoRoot, {
      tenantId: ctx.tenantId,
      sessionId: opts.currentSessionId || activeSnapshot?.session_id || null,
      pipeline: 'context',
      query,
      explainMode: false,
      results: selectedItems.map((s) => ({
        memoryId: s.entry.id,
        score: s.score,
      })),
    });
    localIndex.last_trace_id = traceId !== null ? String(traceId) : null;
    saveIndex(ctx.hippoRoot, localIndex);

    updateStats(ctx.hippoRoot, { recalled: selectedItems.length });

    // Replace selectedItems entries with markRetrieved-updated copies so
    // the returned ContextResult reflects post-recall state.
    selectedItems = selectedItems.map((s) => ({
      ...s,
      entry: updatedEntries.find((u) => u.id === s.entry.id) ?? s.entry,
    }));

    // Read after strengthenRetrieved commits, so the rows just retrieved count at their new strength.
    if (config.ambient.enabled) {
      const filter = { exactScope, project: originProject, currentProject: currentProjectName, now: evalNow() };
      const roots = [...(hasLocal ? [ctx.hippoRoot] : []), ...(hasGlobal && !primaryIsGlobal ? [globalRoot] : [])];
      const tallies = roots.map((root) => loadAmbientTallies(root, ctx.tenantId, filter));
      const total = tallies.length > 0 ? tallies.reduce(addAmbientTallies) : undefined;
      if (total && total.total > 0) ambientState = ambientStateFromTallies(total);
    }
  }

  return {
    entries: selectedItems,
    tokens: totalTokens,
    activeSnapshot: shownSnapshot ?? undefined,
    sessionHandoff: shownHandoff ?? undefined,
    recentEvents: shownEvents.length > 0 ? shownEvents : undefined,
    ambientState,
  };
}
