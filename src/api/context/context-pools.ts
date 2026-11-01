// Which rows a context call loads.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type {
  AmbientLoadResult,
  ContextCandidateFilter,
  AmbientRecallRequest,
  AmbientRefusal,
  RecentOrigins,
} from '../../base/ports/store/context-reads.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../base/rank/search-types.js';
import type { SessionHandoff } from '../../base/session/handoff.js';
import { projectNames } from '../../base/scope/project-identity.js';
import {
  ambientAdmits,
  ambientEnvelopeAdmits,
  type AmbientAdmission,
} from '../../base/scope/read-admission.js';
import type { ContextOptions } from './context-types.js';
import type { Context } from '../types.js';
import { NO_QUERY, globalSource, type ContextPlan, type ContextSource } from './context-plan.js';

export interface ContextAdmission {
  /** `admit` as data, for a store to apply. */
  rule: AmbientAdmission;
  admit: (e: MemoryEntry) => boolean;
  /** What the two-store search admits: `admit` without the own-session compaction rule. */
  bothStoresAdmit: (e: MemoryEntry) => boolean;
}

export interface ContextPools {
  local: AmbientLoadResult;
  global: AmbientLoadResult;
}

/** Most rows per store a no-query context reads; past it, ranking sees the strongest by decay. */
const CONTEXT_CANDIDATE_CAP = 2000;
/** The page is sized from the rows the budget can pay for: a memory under this many tokens is
 * rarer than the slack. */
const CONTEXT_PAGE_ROW_TOKENS = 20;
/** Strength also weighs recall count and valence, so the strongest rows by strength sit a few
 * times deeper than their decay rank; the page reads that many times the rows it can return. */
const CONTEXT_PAGE_SLACK = 4;
/** The smallest page, so a tiny budget or limit still ranks a real candidate set. */
const CONTEXT_PAGE_MIN = 200;

/** Rows per store a no-query context reads: the strongest by decay, enough to fill the budget
 * and the limit. */
function contextCandidatePage(left: number, limit: number): number {
  const returnable = Math.min(Math.ceil(Math.max(0, left) / CONTEXT_PAGE_ROW_TOKENS), limit);
  return Math.min(
    CONTEXT_CANDIDATE_CAP,
    Math.max(CONTEXT_PAGE_MIN, Math.ceil(returnable * CONTEXT_PAGE_SLACK)),
  );
}

/** A query reads recall's FTS window from each store; the search's vector arm adds the nearest
 * rows. */
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

/** What one store's ambient read is asked for. `recent`, `admission`, `recall` and `onRefused`
 * apply to the pinned-only branch alone. */
interface LoadAmbientEntriesOptions {
  readonly pinnedOnly: boolean;
  readonly recent: RecentRequest;
  readonly admit: (e: MemoryEntry) => boolean;
  /** `admit` without the delivery observer, so a row checked twice is not refused twice in the
   * ledger. */
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
  // The store applies the quality floor too, or its recent-N load stops short of a store whose
  // newest rows are junk.
  const loaded = await source.reads.ambientCandidates(tenantId, {
    recentNeeded: recent.needed,
    admit: admission,
    recall,
    origins: recent.origins,
  });
  if (onRefused) for (const refusal of loaded.refused) onRefused(refusal);
  // Pins and recent rows reach core only through the store's own call to admit, so core applies it
  // again with the tenant.
  const entries = loaded.entries.filter((e) => ownTenant(e) && recheck(e));
  return loaded.recall ? { entries, recall: loaded.recall.filter(ownTenant) } : { entries };
}

export function ambientAdmission(
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
    handoffSessionId:
      shownHandoff?.evidence?.derivedFrom === 'transcript' ? shownHandoff.sessionId : undefined,
  };
  const admit = (e: MemoryEntry): boolean => ambientAdmits(e, rule);
  // The two-store search has always ranked a session's own compaction items; only the local search
  // drops them.
  const bothStoresAdmit = (e: MemoryEntry): boolean =>
    !e.supersededBy && ambientEnvelopeAdmits(e, rule);
  return { rule, admit, bothStoresAdmit };
}

/**
 * Origins the recent backfill may read past its first window; on a shared store, only the caller's
 * own project rows.
 */
function recentOrigins(plan: ContextPlan): RecentOrigins | undefined {
  if (plan.sharedStore) {
    return { names: projectNames(plan.currentProject).filter((n) => n !== ''), userGlobal: false };
  }
  return plan.originProject && { names: plan.originProject, userGlobal: true };
}

interface LoadPoolsOptions {
  readonly plan: ContextPlan;
  readonly admission: ContextAdmission;
  readonly recallRequest: AmbientRecallRequest | undefined;
  readonly left: number;
}

export async function loadPools(
  ctx: Context,
  { plan, admission, recallRequest, left }: LoadPoolsOptions,
): Promise<ContextPools> {
  const { obs, pinnedOnly, primaryIsGlobal, hasGlobal } = plan;
  const recent: RecentRequest = { needed: plan.includeRecent, origins: recentOrigins(plan) };
  const searches = plan.query !== NO_QUERY && !pinnedOnly;
  const searchesBoth = searches && hasGlobal && !primaryIsGlobal;
  const poolAdmit = searchesBoth ? admission.bothStoresAdmit : admission.admit;
  const loadAdmit = obs ? obs.watchAdmit(poolAdmit) : poolAdmit;
  const window = candidateWindow(plan, searches, left);
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
    ? await loadAmbientEntries(plan.local, ctx.tenantId, {
        ...read,
        onRefused: refusalReporter(plan, primaryIsGlobal),
      })
    : { entries: [] };
  const global: AmbientLoadResult =
    hasGlobal && !primaryIsGlobal
      ? await loadAmbientEntries(globalSource(ctx), ctx.tenantId, {
          ...read,
          onRefused: refusalReporter(plan, true),
        })
      : { entries: [] };
  return { local, global };
}

// With prompt recall on, eligibility reports a row the quality floor drops.
function refusalReporter(
  plan: ContextPlan,
  isGlobal: boolean,
): ((refusal: AmbientRefusal) => void) | undefined {
  const { obs } = plan;
  return (
    obs &&
    ((r) => {
      if (r.reason === 'admission') obs.filtered(r.id);
      else if (!plan.promptRecallPending) obs.qualityDropped(r.id, isGlobal);
    })
  );
}

// The window's predicates are ones admit applies anyway, so below the cap the admitted rows
// are unchanged.
function candidateWindow(
  plan: ContextPlan,
  searches: boolean,
  left: number,
): ContextCandidateFilter | ContextQueryWindow {
  const { exactScope, ownScope } = plan;
  return searches
    ? { query: plan.query, exactScope, ownScope, project: plan.originProject }
    : {
        exactScope,
        ownScope,
        project: plan.originProject,
        cap: contextCandidatePage(left, plan.limit),
        now: plan.now,
      };
}
