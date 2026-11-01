// The `hippo recall` stage flags and how each one is read.

import { envActiveScope, envHippoSessionId } from '../../base/util/env.js';
import { Layer } from '../../base/memory/entry.js';
import { DEFAULT_RECALL_BUDGET } from '../../base/rank/search-types.js';
import * as api from '../../api/index.js';
import type { HippoConfig } from '../../base/config/config.js';
import type {
  RankRecallStages,
  RecallGraphHops,
  RecallGraphStream,
  RecallReranker,
} from '../../api/recall/pipeline.js';
import {
  recallRerankerPick,
  recallStoreSetting,
  DEFAULT_MAX_NEIGHBORS,
  MAX_HOPS,
  type RecallRerankerPick,
  type RecallStoreSetting,
} from '../../api/recall/rows.js';
import { cliInfra } from './api-context.js';
import {
  type CliFlags,
  type EngineFlags,
  type ParsedFlag,
  boolFlag,
  engineFlags,
  failLater,
  flagValueless,
  hasFlag,
  intFlagInRange,
  numberFlag,
  parseAsOfFlag,
  parseBudgetFlag,
  parseLimitFlag,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { MAX_NEIGHBORS_FLAG } from './flag-defaults.js';

type RecallStageFlags = Pick<
  RankRecallStages,
  'graphHops' | 'reranker' | 'salienceThreshold' | 'outcome' | 'layer'
>;

/** `--graph-stream` implies rrf fusion as well as the graph stream; the CLI fuses the local
 * store only. */
function parseGraphStreamFlags(flags: CliFlags): RecallGraphStream {
  const hops = intFlagInRange(flags, 'graph-hops', { min: 1, max: MAX_HOPS, example: '2' });
  hops.fail?.();
  const seeds = intFlagInRange(flags, 'graph-seeds', { min: 1, example: '10' });
  seeds.fail?.();
  return { hops: hops.value, seeds: seeds.value };
}

function parseHopsFlags(flags: CliFlags): ParsedFlag<RecallGraphHops> {
  const hops = intFlagInRange(flags, 'hops', { min: 0, max: MAX_HOPS, example: '1' });
  if (hops.value === undefined) return { fail: hops.fail };
  const neighbors = intFlagInRange(flags, 'max-neighbors', { min: 1, max: MAX_NEIGHBORS_FLAG });
  if (neighbors.fail) return { fail: neighbors.fail };
  return { value: { hops: hops.value, maxNeighbors: neighbors.value ?? DEFAULT_MAX_NEIGHBORS } };
}

function parseRerankerFlag(flags: CliFlags): ParsedFlag<RecallReranker> {
  const nameRaw = stringFlag(flags, 'reranker');
  if (hasFlag(flags, 'reranker') && nameRaw === undefined) {
    return { fail: failLater('--reranker requires a value.') };
  }
  const name = nameRaw?.trim() ?? '';
  let picked: RecallRerankerPick | null;
  try {
    picked = recallRerankerPick({ infra: cliInfra() }, name);
  } catch (err) {
    // Deferred like the other stage flags, so a bad flag earlier in pipeline order fails first.
    return {
      fail: () => {
        throw err;
      },
    };
  }
  if (!picked) return {};
  const { fn } = picked;
  // slice(0, -1) would quietly drop the last candidate rather than fail.
  const topK = intFlagInRange(flags, 'reranker-top-k', { min: 1 });
  if (topK.fail) return { fail: topK.fail };
  return { value: { fn, topK: topK.value ?? picked.defaultTopK } };
}

function parseSalienceFlag(flags: CliFlags): ParsedFlag<number> {
  // A bare --salience-threshold has always read as 1, since Number(true) is 1.
  const raw = flagValueless(flags, 'salience-threshold')
    ? '1'
    : stringFlag(flags, 'salience-threshold');
  if (raw === undefined) return {};
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return {
      fail: failLater(`Invalid --salience-threshold: "${raw}". Must be a positive number.`),
    };
  }
  return { value: threshold };
}

function parseChoiceFlag(
  flags: CliFlags,
  name: 'outcome' | 'layer',
  valid: readonly string[],
): ParsedFlag<string> {
  const raw = stringFlag(flags, name);
  if (hasFlag(flags, name) && raw === undefined) {
    return { fail: failLater(`--${name} requires a value. Must be one of: ${valid.join(', ')}.`) };
  }
  const value = raw?.trim() ?? '';
  if (!value) return {};
  if (!valid.includes(value)) {
    return {
      fail: failLater(`Invalid --${name}: "${value}". Must be one of: ${valid.join(', ')}.`),
    };
  }
  return { value };
}

/** Parses every flag a ranking stage reads and fails on the first invalid one in pipeline order. */
function parseStageFlags(flags: CliFlags): RecallStageFlags {
  const graphHops = parseHopsFlags(flags);
  const reranker = parseRerankerFlag(flags);
  const salience = parseSalienceFlag(flags);
  const outcome = parseChoiceFlag(flags, 'outcome', ['success', 'failure', 'partial']);
  const layer = parseChoiceFlag(flags, 'layer', Object.values(Layer));
  for (const flag of [graphHops, reranker, salience, outcome, layer]) flag.fail?.();
  return {
    graphHops: graphHops.value,
    reranker: reranker.value,
    salienceThreshold: salience.value,
    outcome: outcome.value,
    layer: layer.value,
  };
}

/** What `hippo recall` reads: its flags, the store setting they pick, the tenant and the
 * store's config. */
export interface ParsedRecallFlags {
  readonly budget: number;
  readonly limit: number;
  readonly asJson: boolean;
  readonly showWhy: boolean;
  readonly includeSuperseded: boolean;
  readonly asOf: string | undefined;
  readonly setting: RecallStoreSetting;
  readonly tenantId: string;
  readonly explicitScope: string | null;
  readonly config: HippoConfig;
  readonly minResults: number | undefined;
  readonly graphStream: RecallGraphStream | undefined;
  readonly goalTag: string;
  readonly sessionId: string;
  readonly engine: EngineFlags;
  readonly stages: RecallStageFlags;
  readonly includeContinuity: boolean;
}

/** Every flag recall reads, parsed in a fixed order because the first invalid flag decides which
 * error prints; all of them are checked before ranking starts. */
export function parseRecallFlags(ctx: api.Context, flags: CliFlags): ParsedRecallFlags {
  const budget = parseBudgetFlag(flags, DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags, 'limit');
  const asJson = boolFlag(flags, 'json');
  const showWhy = boolFlag(flags, 'why');
  const includeSuperseded = boolFlag(flags, 'include-superseded');
  const asOf = parseAsOfFlag(flags);
  // The explicit --scope is the filter input; the detected scope only boosts, so auto-detection
  // never filters.
  const explicitScope = stringFlagOrExit(flags, 'scope') ?? null;
  const setting = recallStoreSetting(ctx, explicitScope || envActiveScope());
  const config = ctx.config;
  const minResults = numberFlag(flags, 'min-results');
  const graphStream = boolFlag(flags, 'graph-stream') ? parseGraphStreamFlags(flags) : undefined;
  const goalTag = stringFlagOrExit(flags, 'goal') ?? '';
  const sessionId = (stringFlagOrExit(flags, 'session-id') ?? envHippoSessionId() ?? '').trim();
  const engine = engineFlags(flags, config);
  const stages = parseStageFlags(flags);
  return {
    budget,
    limit,
    asJson,
    showWhy,
    includeSuperseded,
    asOf,
    setting,
    tenantId: ctx.tenantId,
    explicitScope,
    config,
    minResults,
    graphStream,
    goalTag,
    sessionId,
    engine,
    stages,
    includeContinuity: boolFlag(flags, 'continuity'),
  };
}
