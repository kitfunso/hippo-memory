// Which stores a context call reaches and what it may spend.
import type { StrengthModel } from '../../base/memory/strength.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { ContextReads, HippoStore } from '../../base/ports/store.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { ProjectRef } from '../../base/scope/project-identity.js';
import type { DeliveryObserver } from '../delivery/delivery-recorder.js';
import type { ContextCost, ContextOptions } from './context-types.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { BadRequestError } from '../../base/errors/api-errors.js';
import { log } from '../../base/util/log.js';
import {
  classifyOriginProject,
  projectId,
  projectNames,
} from '../../base/scope/project-identity.js';
import { DEFAULT_CONFIG } from '../../base/config/config.js';
import { promptTokens } from '../../base/rank/prompt-recall.js';
import { personalScopeOf } from '../../base/scope/recall-scope.js';
import { finiteOr } from '../../domain/context/select-policy.js';
import { type Context, type ContextReach, type GlobalInReach, strengthOf } from '../types.js';
import type { AmbientRecallRequest } from '../../base/ports/store/context-reads.js';

/** One store contextGet reads rows from: its base search and its context reads. */
export interface ContextSource {
  readonly store: HippoStore;
  readonly reads: ContextReads;
}

/** What contextGet resolved from opts and config before it read a row. */
export interface ContextPlan {
  /** The served store, else hippo.db under the root. */
  local: ContextSource;
  pinnedOnly: boolean;
  limit: number;
  includeRecent: number;
  activeScope: string;
  exactScope: string | undefined;
  /** The caller's personal scope, from its authenticated owner; the default deny admits it. */
  ownScope: string | undefined;
  query: string;
  hasLocal: boolean;
  hasGlobal: boolean;
  globalRoot: string;
  primaryIsGlobal: boolean;
  hasLocalTaskState: boolean;
  sharedStore: boolean;
  config: HippoConfig;
  currentProject: ProjectRef;
  includeCrossProject: boolean;
  originProject: readonly string[] | undefined;
  promptRecallPending: boolean;
  cost: ContextCost | undefined;
  price: (entry: MemoryEntry, isGlobal: boolean, promptRecall?: boolean) => number;
  obs: DeliveryObserver | undefined;
  /** The instant the whole read scores strength at, by the model its Context runs under. */
  now: Date;
  strength: StrengthModel;
}

/** The operator's global store, which planContext proved present before it set hasGlobal. */
export function globalStoreInReach(ctx: Context): HippoStore {
  return globalInReach(ctx).store;
}

export function globalInReach(ctx: Context): GlobalInReach {
  const global = ctx.reach?.global;
  if (global === undefined) throw new Error('hasGlobal without a global store in reach');
  return global;
}

// The plan's query when the caller gave none: context then ranks by strength instead of searching.
export const NO_QUERY = '*';

/** A store's base search and context reads, both required on the port. */
export function sourceOf(store: HippoStore): ContextSource {
  return { store, reads: store.contextReads };
}

/** Which stores this read can draw on, and what kind the primary one is. */
function storesInReach(ctx: Context, opts: ContextOptions) {
  // No reach means an integrator's own store: one project, no global store beside it.
  const reach: ContextReach = ctx.reach ?? {
    hasLocal: true,
    isGlobal: false,
    shared: ctx.config.sharedStore,
  };
  // The store's own flag counts too, so no surface can read a shared store as its owner.
  const sharedStore = opts.sharedStore === true || reach.shared;
  // A store serving many people is not its operator's, so the operator's own global store stays
  // out; the root sets `global` only beside hippo.db.
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

export function globalSource(ctx: Context): ContextSource {
  return sourceOf(globalStoreInReach(ctx));
}

/** Prices one entry against the budget: the caller's cost model when it gave one, else a token
 * estimate. */
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

type StoreReach = ReturnType<typeof storesInReach>;

function reachFields(
  reach: StoreReach,
): Pick<
  ContextPlan,
  'hasLocal' | 'hasGlobal' | 'globalRoot' | 'primaryIsGlobal' | 'hasLocalTaskState' | 'sharedStore'
> {
  return {
    hasLocal: reach.hasLocal,
    hasGlobal: reach.hasGlobal,
    globalRoot: reach.globalRoot,
    primaryIsGlobal: reach.primaryIsGlobal,
    hasLocalTaskState: reach.hasLocal && !reach.primaryIsGlobal,
    sharedStore: reach.sharedStore,
  };
}

// opts.scope is only the tag boost, opts.exactScope the envelope request; other-project memories
// are excluded unless the caller asks for them (crossProject) or isolation is disabled.
function readsCrossProject(ctx: Context, opts: ContextOptions, sharedStore: boolean): boolean {
  const isolationEnabled = ctx.config.contextProjectIsolation !== false;
  // A caller with no project reads every row as its own; on a shared store those rows are other
  // people's.
  if (sharedStore && projectId(opts.currentProject).trim() === '') {
    throw new BadRequestError("a shared store needs the caller's project");
  }
  // A laptop config copied onto a team store must not open every member's rows to every prompt.
  if (sharedStore && !isolationEnabled) {
    log.once(
      'context-isolation-ignored',
      'warn',
      '"contextProjectIsolation": false is ignored on a shared store; a read opts in with cross_project.',
    );
  }
  return opts.crossProject === true || (!isolationEnabled && !sharedStore);
}

export function planContext(ctx: Context, opts: ContextOptions, local: ContextSource): ContextPlan {
  const pinnedOnly = opts.pinnedOnly === true;
  const reach = storesInReach(ctx, opts);
  const query = (opts.q ?? '').trim() || NO_QUERY;
  const config = ctx.config;
  const currentProject = opts.currentProject;
  const includeCrossProject = readsCrossProject(ctx, opts, reach.sharedStore);
  // Decided before the ambient loads so the pinned-only FTS candidate query can share
  // their connection.
  const promptRecallPending =
    pinnedOnly && Boolean(opts.prompt?.trim()) && config.pinnedInject.promptRecall === true;
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
    ...reachFields(reach),
    config,
    currentProject,
    includeCrossProject,
    originProject:
      includeCrossProject || projectId(currentProject) === ''
        ? undefined
        : projectNames(currentProject),
    promptRecallPending,
    cost,
    price,
    obs: opts.deliveryObserver,
    now: ctx.infra.clock(),
    strength: strengthOf(ctx),
  };
}

/** The prompt-recall candidate request the ambient loads carry, when the prompt has any terms. */
export function promptRecallRequest(
  opts: ContextOptions,
  plan: ContextPlan,
): AmbientRecallRequest | undefined {
  const { pinnedInject } = plan.config;
  const promptRecallTerms =
    plan.promptRecallPending && pinnedInject.enabled
      ? Array.from(promptTokens(opts.prompt ?? ''))
      : [];
  return promptRecallTerms.length > 0
    ? {
        terms: promptRecallTerms,
        limit: Math.floor(
          finiteOr(pinnedInject.promptRecallCandidates, {
            fallback: DEFAULT_CONFIG.pinnedInject.promptRecallCandidates,
            min: 1,
          }),
        ),
        ownScope: plan.ownScope,
      }
    : undefined;
}

/** Reports the block's facts to the observer and returns the budget left after the fixed
 * headers. */
export function openBlockBudget(plan: ContextPlan, opts: ContextOptions, budget: number): number {
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
