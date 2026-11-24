import { isRecallOnly, type MemoryEntry } from '../../base/memory/entry.js';
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
import { isSuperseded } from '../../base/memory/liveness.js';

/** The ambient admit rules. */
export interface ContextAdmission {
  rule: AmbientAdmission;
  admit: (e: MemoryEntry) => boolean;
  bothStoresAdmit: (e: MemoryEntry) => boolean;
}

export interface ContextPools {
  local: AmbientLoadResult;
  global: AmbientLoadResult;
}

const CONTEXT_CANDIDATE_CAP = 2000;
const CONTEXT_PAGE_ROW_TOKENS = 20;
const CONTEXT_PAGE_SLACK = 4;
const CONTEXT_PAGE_MIN = 200;

function contextCandidatePage(left: number, limit: number): number {
  const returnable = Math.min(Math.ceil(Math.max(0, left) / CONTEXT_PAGE_ROW_TOKENS), limit);
  return Math.min(
    CONTEXT_CANDIDATE_CAP,
    Math.max(CONTEXT_PAGE_MIN, Math.ceil(returnable * CONTEXT_PAGE_SLACK)),
  );
}

interface ContextQueryWindow {
  query: string;
  exactScope: string | undefined;
  ownScope: string | undefined;
  project: readonly string[] | undefined;
}

interface RecentRequest {
  needed: number;
  origins: RecentOrigins | undefined;
}

interface LoadAmbientEntriesOptions {
  readonly pinnedOnly: boolean;
  readonly recent: RecentRequest;
  readonly admit: (e: MemoryEntry) => boolean;
  readonly recheck: (e: MemoryEntry) => boolean;
  readonly admission: AmbientAdmission;
  readonly window: ContextCandidateFilter | ContextQueryWindow;
  readonly recall?: AmbientRecallRequest;
  readonly onRefused?: (refusal: AmbientRefusal) => void;
}

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
    // SHORTCUT: a search filters notes after its limit, so a query matching 200 notes returns fewer rows or none;
    // push it into the search SQL if a store gets there.
    return {
      entries: rows.filter((e) => ownTenant(e) && admit(e) && (e.pinned || !isRecallOnly(e))),
    };
  }
  const loaded = await source.reads.ambientCandidates(tenantId, {
    recentNeeded: recent.needed,
    admit: admission,
    recall,
    origins: recent.origins,
  });
  if (onRefused) for (const refusal of loaded.refused) onRefused(refusal);
  const entries = loaded.entries.filter((e) => ownTenant(e) && recheck(e));
  return loaded.recall ? { entries, recall: loaded.recall.filter(ownTenant) } : { entries };
}

export function ambientAdmission(
  opts: ContextOptions,
  plan: ContextPlan,
  digestHandoff: SessionHandoff | null,
): ContextAdmission {
  const rule: AmbientAdmission = {
    currentProject: plan.currentProject,
    includeCrossProject: plan.includeCrossProject,
    exactScope: plan.exactScope,
    ownScope: plan.ownScope,
    ownSessionId: opts.currentSessionId || undefined,
    handoffSessionId:
      digestHandoff?.evidence?.derivedFrom === 'transcript' ? digestHandoff.sessionId : undefined,
    excludeTags: plan.pinnedOnly ? plan.config.pinnedInject.excludeTags : undefined,
  };
  const admit = (e: MemoryEntry): boolean => ambientAdmits(e, rule);
  const bothStoresAdmit = (e: MemoryEntry): boolean =>
    !isSuperseded(e) && ambientEnvelopeAdmits(e, rule);
  return { rule, admit, bothStoresAdmit };
}

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

/** The tokens of the user-rule heading: nothing unless a loaded row prints under it. SHORTCUT: paid
 * when the pool holds a user rule, even if the ranking then leaves it out; one heading of slack. */
export function userRuleReserve(plan: ContextPlan, pools: ContextPools): number {
  const { cost } = plan;
  const held =
    pools.local.entries.some((e) => plan.isUserRule(e, plan.primaryIsGlobal)) ||
    pools.global.entries.some((e) => plan.isUserRule(e, true));
  if (!cost || !held) return 0;
  const can = { cross: false, promptRecall: false, ambient: false };
  return cost.fixed(0, { ...can, userRule: true }) - cost.fixed(0, { ...can, userRule: false });
}

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
