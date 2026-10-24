/**
 * Hippo's config: its shape, its defaults and the rule for each key of .hippo/config.json. src/host reads the file.
 */

import { type PhysicsConfig, DEFAULT_PHYSICS_CONFIG } from '../rank/physics-config.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../memory/memory.js';
import { SALIENCE_DEFAULTS } from '../memory/salience.js';
import type { PromptRecallMetric } from '../rank/prompt-recall.js';
import { DEFAULT_LOCAL_BUMP, DEFAULT_MMR_LAMBDA, DEFAULT_RECALL_BUDGET } from '../rank/search-types.js';
import type { JsonValue } from '../util/json.js';
import {
  basisPoints,
  block,
  choice,
  count,
  finite,
  flag,
  flagOrAuto,
  fraction,
  positive,
  text,
  textList,
  textListOrAll,
  type FieldReader,
  type Reader,
} from './config-rules.js';

export type DecayBasis = 'clock' | 'session' | 'adaptive';

export interface HippoConfig {
  defaultHalfLifeDays: number;
  defaultBudget: number;
  defaultContextBudget: number;
  decayBasis: DecayBasis;
  autoLearnOnSleep: boolean;
  autoShareOnSleep: boolean;
  autoSleep: {
    enabled: boolean;
    threshold: number; // trigger sleep after this many new memories
  };
  embeddings: {
    enabled: boolean | 'auto'; // 'auto' = use if dependency installed (local) / key present (api)
    model: string;
    hybridWeight: number;
    /** Embedding backend: 'local' (default) = zero-dependency transformers.js; 'openai' | 'voyage' | 'cohere' = opt-in
     * API embedder needing the provider's
     * API key in env (OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY). See src/infra/embedding-provider.ts. */
    provider?: 'local' | 'openai' | 'voyage' | 'cohere';
    /** Optional API base-URL override (self-host / proxy). HTTPS only (localhost may use http). Ignored by the local
     *  provider. */
    apiBaseUrl?: string;
    /** Batch size for API embedding requests. Default 64. */
    batchSize?: number;
  };
  global: {
    enabled: boolean;
  };
  gitLearnPatterns: string[];
  physics: PhysicsConfig;
  /** MMR (Maximal Marginal Relevance) re-ranking settings. Applied only when embeddings are available: needs doc-to-doc
   *  similarity. */
  mmr: {
    enabled: boolean;
    /** 1.0 = pure relevance (current behavior). 0.0 = pure diversity. 0.7 is a typical balance. */
    lambda: number;
  };
  search: {
    /** Multiplier applied to local-store scores when merged with global results (searchBothHybrid). 1.0 = no bias,
     *  1.2 = 20% local priority. */
    localBump: number;
  };
  /** Replay settings — biologically-inspired rehearsal during consolidation. */
  replay: {
    /** How many surviving memories to rehearse per sleep cycle. 0 disables. */
    count: number;
  };
  /** Auto-promote completed sessions into trace-layer memories on sleep. */
  autoTraceCapture: boolean;
  /** Only promote sessions whose session_complete event is within N days. */
  autoTraceWindowDays: number;
  /** Mid-session pinned-rule re-injection through the UserPromptSubmit hook: pinned memories are re-injected each turn
   * within the token budget. */
  pinnedInject: {
    enabled: boolean;
    budget: number;
    /** Skip a block identical to the one already injected this session
     *  Default true. Needs a session id from the hook payload. */
    skipUnchanged: boolean;
    /** Resend an unchanged block after this many consecutive skips, so long sessions still see pinned rules near the
     * latest turn (default 10; 0 never resends). */
    refreshTurns: number;
    /** Gate the hook's backfill on the prompt's own content instead of the five newest memories. Default true: the same
     *  overlap for fewer tokens. */
    promptRecall: boolean;
    /** Overlap metric for the prompt-recall gate. Default 'jaccard' (tuned). */
    promptRecallMetric: PromptRecallMetric;
    /** Minimum overlap score to admit a candidate. Default 0.04 (tuned). */
    promptRecallThreshold: number;
    /** Minimum shared tokens to admit a candidate. Default 2. */
    promptRecallMinShared: number;
    /** Max prompt-recall entries injected per prompt. Default 5 (tuned). */
    promptRecallMaxItems: number;
    /** FTS candidate pool size per store before gating. Default 100. */
    promptRecallCandidates: number;
  };
  /** Memory scope isolation (default true): ambient context (`hippo context`, the hook, /v1/context, MCP hippo_context)
   * excludes OTHER projects' memories; explicit recall is unaffected. False disables the ORIGIN PARTITION only: the
   * secret veto is unconditional, and no flag re-includes secret-flagged rows. */
  contextProjectIsolation: boolean;
  extraction: {
    enabled: boolean | 'auto';
    model: string;
  };
  multihop: {
    enabled: boolean;
  };
  salience: {
    enabled: boolean;
    recentWindow: number;
    overlapThreshold: number;
    minContentLength: number;
    maxRepeatErrors: number;
  };
  ambient: {
    enabled: boolean;
  };
  /** Opt-in learned memory-value rescue veto on the sleep decay pass. Default OFF: the frozen weights
   * (src/domain/consolidate/memory-value-weights.ts) only run when enabled; the rescue budget is a code constant, not
   * user-tunable. */
  memoryValue: {
    enabled: boolean;
  };
  /** Dormant memories (sqlite/dormant.ts), on by default: the sleep decay pass moves a memory that faded below the
   * threshold there instead of deleting it (`hippo dormant restore|forget <id>`); a faded memory the secret detector
   * flags is always deleted. `{"enabled": false}` restores delete-on-fade. */
  dormant: {
    enabled: boolean;
    /** Days a dormant memory is kept before sleep deletes it for good.
     *  Default 180. 0 keeps dormant memories forever. */
    retentionDays: number;
  };
  /** Tags a memory `churn-stale` when its named file/symbol/script changed since storage. Default OFF until a
   *  measurement justifies the flip. */
  churnStaleness: {
    enabled: boolean;
  };
  /** Which agents' own memories init, sleep and session end import: tool ids, null for every tool, [] for none. */
  agentMemories: {
    tools: string[] | null;
  };
  /** Per-turn delivery ledger (src/store/sqlite/recall-trace.ts): hashes, ids, counts and rejection reasons for each
   *  pinned-only context call. Default off; read from the store the token ledger writes to. */
  deliveryLedger: {
    enabled: boolean;
  };
  /** Pilot holdout (src/api/pilot-arm.ts): share of sessions, in basis points 0-10000, that get no memories pushed.
   *  Default 0 = off. Read from the store the token ledger writes to. */
  pilot: {
    holdoutRateBp: number;
  };
  /** How a folder's project is named. `remote: false` drops the origin-remote rule, leaving `.hippo-project.json` then
   *  the folder name. Read from the global store's config only, so every store agrees. */
  projectIdentity: {
    remote: boolean;
  };
  /** The store serves many people, so a write that names no project is stamped NULL, never this folder's project, and a
   *  context read must name the caller's project. Default false. Read it through isSharedStore. */
  sharedStore: boolean;
  /** The served store's vector graph. Past `maxVectors` stored vectors it keeps none, so the worker's heap stays
   *  bounded, and nearest-row reads scan; docs/ARCHITECTURE.md has the heap a vector costs. */
  vectorGraph: {
    maxVectors: number;
  };
  /** What the composition root read from the environment for this command or request; config.json never sets it. */
  runtime?: RuntimeSettings;
}

/** Process settings a root reads from env vars; each absent field takes the default its reader names. */
export interface RuntimeSettings {
  /** HIPPO_ANCHORING=off turns the anchoring hint off; on by default. */
  readonly anchoringHint?: boolean;
  /** HIPPO_AVAILABILITY=off turns the availability hint off; on by default. */
  readonly availabilityHint?: boolean;
  /** HIPPO_AUTODEBIAS=off skips the planning-fallacy claim check; on by default. */
  readonly autodebias?: boolean;
  /** HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1 refuses a fresh tail that names no session. */
  readonly requireSessionScopedFreshTail?: boolean;
  /** HIPPO_SUMMARY_DEBOOST, used only inside (0, 1]. */
  readonly summaryDeboost?: number;
  /** HIPPO_QUERY_EMBED_TIMEOUT_MS: how long a recall waits for its query vector. */
  readonly queryEmbedTimeoutMs?: number;
  /** HIPPO_DAG_REBUILD_CAP: summaries one sleep rebuilds. */
  readonly dagRebuildCap?: number;
  /** HIPPO_SCOPE, else GSTACK_SKILL, else OPENCLAW_SKILL: the scope recall boosts. */
  readonly activeScope?: string;
  /** HIPPO_LOSS_AVERSION_RATIO, which scales an error memory's strength; strength scoring applies its floor. */
  readonly lossAversionRatio?: number;
  /** Where the CLEF rerankers send a request; without it they keep the native order. */
  readonly clef?: ClefSettings;
}

/** The CLEF rerankers' transport, read by the root: HIPPO_CLEF_ENDPOINT wins over hosted Workers AI. */
export interface ClefSettings {
  /** HIPPO_CLEF_ENDPOINT, trimmed. */
  readonly endpoint?: string;
  /** HIPPO_CLEF_ENDPOINT_TOKEN, sent only to `endpoint`. */
  readonly endpointToken?: string;
  /** HIPPO_CLEF_TIMEOUT_MS as a whole number above zero; "15s" and "1e3" read as unset. */
  readonly timeoutMs?: number;
  /** CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, trimmed; empty when unset. */
  readonly cloudflareAccountId: string;
  readonly cloudflareApiToken: string;
}

/** The `embeddings` block, which the embedding provider reads alone. */
export type EmbeddingsConfig = HippoConfig['embeddings'];

export const DEFAULT_CONFIG: HippoConfig = {
  defaultHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  defaultBudget: DEFAULT_RECALL_BUDGET,
  defaultContextBudget: 3000,
  decayBasis: 'adaptive',
  autoLearnOnSleep: true,
  autoShareOnSleep: true,
  autoSleep: {
    enabled: true,
    threshold: 50,
  },
  embeddings: {
    enabled: 'auto',
    model: 'Xenova/all-MiniLM-L6-v2',
    hybridWeight: 0.6,
    provider: 'local',
  },
  global: {
    enabled: true,
  },
  gitLearnPatterns: [
    'fix',
    'revert',
    'bug',
    'error',
    'hotfix',
    'bugfix',
    'refactor',
    'perf',
    'chore',
    'breaking',
    'deprecate',
  ],
  physics: { ...DEFAULT_PHYSICS_CONFIG },
  mmr: {
    enabled: true,
    lambda: DEFAULT_MMR_LAMBDA,
  },
  search: {
    localBump: DEFAULT_LOCAL_BUMP,
  },
  replay: {
    count: 5,
  },
  autoTraceCapture: true,
  autoTraceWindowDays: 7,
  pinnedInject: {
    enabled: true,
    budget: 1500,
    skipUnchanged: true,
    refreshTurns: 10,
    promptRecall: true,
    promptRecallMetric: 'jaccard',
    promptRecallThreshold: 0.04,
    promptRecallMinShared: 2,
    promptRecallMaxItems: 5,
    promptRecallCandidates: 100,
  },
  contextProjectIsolation: true,
  extraction: {
    enabled: 'auto',
    model: 'claude-sonnet-4-6',
  },
  multihop: {
    enabled: false,
  },
  salience: { enabled: false, ...SALIENCE_DEFAULTS },
  ambient: {
    enabled: true,
  },
  memoryValue: {
    enabled: false,
  },
  dormant: {
    enabled: true,
    retentionDays: 180,
  },
  churnStaleness: {
    enabled: false,
  },
  agentMemories: {
    tools: null,
  },
  deliveryLedger: {
    enabled: false,
  },
  pilot: {
    holdoutRateBp: 0,
  },
  projectIdentity: {
    remote: true,
  },
  sharedStore: false,
  // About 400 MB of worker heap at the measured 1.6 to 2.3 KB a 384-dim vector.
  vectorGraph: {
    maxVectors: 200_000,
  },
};

type ConfigKey = Exclude<keyof HippoConfig, 'runtime'>;
/** A config.json's top-level object, as parsed. */
export type ConfigFile = { [key: string]: JsonValue };

interface ConfigEntry {
  apply(raw: ConfigFile, into: HippoConfig): void;
}

function configKey<K extends ConfigKey>(key: K, read: Reader<HippoConfig[K]>): ConfigEntry {
  return {
    apply: (raw, into) => {
      into[key] = read(raw[key], key);
    },
  };
}

const D = DEFAULT_CONFIG;

function enabledBlock(fallback: { enabled: boolean }): Reader<{ enabled: boolean }> {
  return block('an object like {"enabled": true}', fallback, (read) => ({
    enabled: read('enabled', flag(fallback.enabled)),
  }));
}

// A config file keeps the snake_case physics keys, such as G_query; each reads into its camelCase field.
function physicsFields(read: FieldReader): PhysicsConfig {
  const P = D.physics;
  return {
    enabled: read('enabled', flagOrAuto(P.enabled)),
    gQuery: read('G_query', finite(P.gQuery)),
    gMemory: read('G_memory', finite(P.gMemory)),
    kRepulsion: read('K_repulsion', finite(P.kRepulsion)),
    drag: read('drag', finite(P.drag)),
    interferenceGain: read('interference_gain', finite(P.interferenceGain)),
    momentumWeight: read('momentum_weight', finite(P.momentumWeight)),
    maxVelocity: read('max_velocity', finite(P.maxVelocity)),
    dt: read('dt', finite(P.dt)),
    substeps: read('substeps', count(P.substeps)),
    feedbackAlpha: read('feedback_alpha', finite(P.feedbackAlpha)),
    temperatureDecay: read('temperature_decay', finite(P.temperatureDecay)),
    clusterThreshold: read('cluster_threshold', finite(P.clusterThreshold)),
    clusterTopK: read('cluster_top_k', count(P.clusterTopK)),
  };
}

function pinnedInjectFields(read: FieldReader): HippoConfig['pinnedInject'] {
  const P = D.pinnedInject;
  return {
    enabled: read('enabled', flag(P.enabled)),
    budget: read('budget', count(P.budget)),
    skipUnchanged: read('skipUnchanged', flag(P.skipUnchanged)),
    refreshTurns: read('refreshTurns', count(P.refreshTurns)),
    // The hook turns prompt recall on only for `true`, so a malformed value reads as off, not as the default.
    promptRecall: read('promptRecall', flag(false, P.promptRecall)),
    promptRecallMetric: read('promptRecallMetric', choice(P.promptRecallMetric, 'jaccard', 'cosine')),
    promptRecallThreshold: read('promptRecallThreshold', fraction(P.promptRecallThreshold)),
    promptRecallMinShared: read('promptRecallMinShared', count(P.promptRecallMinShared)),
    promptRecallMaxItems: read('promptRecallMaxItems', count(P.promptRecallMaxItems)),
    promptRecallCandidates: read('promptRecallCandidates', count(P.promptRecallCandidates)),
  };
}

// Every top-level key loadConfig reads. A bad value warns once, in one wording, and reads as the fallback.
const CONFIG_TABLE: readonly ConfigEntry[] = [
  // Every writer starts a memory on this, and a zero or negative half-life scores zero strength.
  configKey('defaultHalfLifeDays', positive(D.defaultHalfLifeDays)),
  configKey('defaultBudget', count(D.defaultBudget)),
  configKey('defaultContextBudget', count(D.defaultContextBudget)),
  configKey('decayBasis', choice(D.decayBasis, 'clock', 'session', 'adaptive')),
  configKey('autoLearnOnSleep', flag(D.autoLearnOnSleep)),
  configKey('autoShareOnSleep', flag(D.autoShareOnSleep)),
  configKey(
    'autoSleep',
    block('an object like {"enabled": true, "threshold": 50}', D.autoSleep, (read) => ({
      enabled: read('enabled', flag(D.autoSleep.enabled)),
      threshold: read('threshold', count(D.autoSleep.threshold)),
    })),
  ),
  configKey(
    'embeddings',
    // `provider` is not read here: an unknown one must reach resolveEmbeddingProvider, which refuses it rather than
    // falling back to local.
    block('an object like {"enabled": "auto"}', D.embeddings, (read) => ({
      enabled: read('enabled', flagOrAuto(D.embeddings.enabled)),
      model: read('model', text(D.embeddings.model)),
      hybridWeight: read('hybridWeight', fraction(D.embeddings.hybridWeight)),
      apiBaseUrl: read('apiBaseUrl', text(D.embeddings.apiBaseUrl)),
      batchSize: read('batchSize', positive(D.embeddings.batchSize)),
    })),
  ),
  configKey('global', enabledBlock(D.global)),
  configKey('gitLearnPatterns', textList(D.gitLearnPatterns)),
  configKey('physics', block('an object of physics constants', D.physics, physicsFields)),
  configKey(
    'mmr',
    block('an object like {"enabled": true, "lambda": 0.7}', D.mmr, (read) => ({
      enabled: read('enabled', flag(D.mmr.enabled)),
      lambda: read('lambda', fraction(D.mmr.lambda)),
    })),
  ),
  configKey(
    'search',
    block('an object like {"localBump": 1.2}', D.search, (read) => ({
      localBump: read('localBump', positive(D.search.localBump)),
    })),
  ),
  configKey(
    'replay',
    block('an object like {"count": 5}', D.replay, (read) => ({ count: read('count', count(D.replay.count)) })),
  ),
  configKey('autoTraceCapture', flag(D.autoTraceCapture)),
  configKey('autoTraceWindowDays', count(D.autoTraceWindowDays)),
  configKey(
    'pinnedInject',
    block('an object like {"enabled": true, "budget": 1500}', D.pinnedInject, pinnedInjectFields),
  ),
  configKey('contextProjectIsolation', flag(D.contextProjectIsolation)),
  configKey(
    'extraction',
    block('an object like {"enabled": "auto"}', D.extraction, (read) => ({
      enabled: read('enabled', flagOrAuto(D.extraction.enabled)),
      model: read('model', text(D.extraction.model)),
    })),
  ),
  configKey('multihop', enabledBlock(D.multihop)),
  configKey(
    'salience',
    block('an object like {"enabled": true}', D.salience, (read) => ({
      enabled: read('enabled', flag(D.salience.enabled)),
      recentWindow: read('recentWindow', count(D.salience.recentWindow)),
      overlapThreshold: read('overlapThreshold', fraction(D.salience.overlapThreshold)),
      minContentLength: read('minContentLength', count(D.salience.minContentLength)),
      maxRepeatErrors: read('maxRepeatErrors', count(D.salience.maxRepeatErrors)),
    })),
  ),
  configKey('ambient', enabledBlock(D.ambient)),
  // A malformed value never silently turns a feature on or off: it warns and reads as the default.
  configKey('memoryValue', enabledBlock(D.memoryValue)),
  configKey(
    'dormant',
    block('an object like {"enabled": false}', D.dormant, (read) => ({
      enabled: read('enabled', flag(D.dormant.enabled)),
      retentionDays: read('retentionDays', count(D.dormant.retentionDays)),
    })),
  ),
  configKey('churnStaleness', enabledBlock(D.churnStaleness)),
  // Absent imports every tool; a malformed list imports none.
  configKey(
    'agentMemories',
    block('an object like {"tools": ["claude-code"]}', D.agentMemories, (read) => ({
      tools: read('tools', textListOrAll('a list of tool ids like ["claude-code", "codex"]')),
    })),
  ),
  configKey('deliveryLedger', enabledBlock(D.deliveryLedger)),
  configKey(
    'pilot',
    block('an object like {"holdoutRateBp": 2000}', D.pilot, (read) => ({
      holdoutRateBp: read('holdoutRateBp', basisPoints(D.pilot.holdoutRateBp)),
    })),
  ),
  configKey(
    'projectIdentity',
    block('an object like {"remote": false}', D.projectIdentity, (read) => ({
      remote: read('remote', flag(D.projectIdentity.remote)),
    })),
  ),
  configKey('sharedStore', flag(D.sharedStore)),
  configKey(
    'vectorGraph',
    block('an object like {"maxVectors": 200000}', D.vectorGraph, (read) => ({
      maxVectors: read('maxVectors', count(D.vectorGraph.maxVectors)),
    })),
  ),
];

/** The config a parsed config.json gives: each key it sets over the defaults; src/host/config-file.ts reads it. */
export function configOverDefaults(raw: ConfigFile): HippoConfig {
  const config: HippoConfig = { ...DEFAULT_CONFIG };
  for (const entry of CONFIG_TABLE) entry.apply(raw, config);
  return config;
}
