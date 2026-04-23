/**
 * Config support for Hippo: reads .hippo/config.json with sane defaults.
 */

import * as fs from 'fs';
import * as path from 'path';
import { type PhysicsConfig, DEFAULT_PHYSICS_CONFIG, mergePhysicsConfig } from './physics-config.js';

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
    threshold: number;  // trigger sleep after this many new memories
  };
  embeddings: {
    enabled: boolean | 'auto';  // 'auto' = use if dependency installed
    model: string;
    hybridWeight: number;
  };
  global: {
    enabled: boolean;
  };
  gitLearnPatterns: string[];
  physics: PhysicsConfig;
  /** MMR (Maximal Marginal Relevance) re-ranking settings. Applied only when
   *  embeddings are available — needs doc-to-doc similarity. */
  mmr: {
    enabled: boolean;
    /** 1.0 = pure relevance (current behavior). 0.0 = pure diversity. 0.7 is
     *  a typical balance. */
    lambda: number;
  };
  search: {
    /** Multiplier applied to local-store scores when merged with global
     *  results (searchBothHybrid). 1.0 = no bias, 1.2 = 20% local priority. */
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
  /** Mid-session pinned-rule re-injection via the Claude Code UserPromptSubmit
   *  hook. When enabled, pinned memories are re-injected each turn within the
   *  given token budget. */
  pinnedInject: {
    enabled: boolean;
    budget: number;
  };
  extraction: {
    enabled: boolean | 'auto';
    model: string;
  };
  multihop: {
    enabled: boolean;
  };
}

const DEFAULT_CONFIG: HippoConfig = {
  defaultHalfLifeDays: 7,
  defaultBudget: 4000,
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
  },
  global: {
    enabled: true,
  },
  gitLearnPatterns: [
    'fix', 'revert', 'bug', 'error', 'hotfix', 'bugfix',
    'refactor', 'perf', 'chore', 'breaking', 'deprecate',
  ],
  physics: { ...DEFAULT_PHYSICS_CONFIG },
  mmr: {
    enabled: true,
    lambda: 0.7,
  },
  search: {
    localBump: 1.2,
  },
  replay: {
    count: 5,
  },
  autoTraceCapture: true,
  autoTraceWindowDays: 7,
  pinnedInject: {
    enabled: true,
    budget: 1500,
  },
  extraction: {
    enabled: 'auto',
    model: 'claude-sonnet-4-6',
  },
  multihop: {
    enabled: false,
  },
};

export function loadConfig(hippoRoot: string): HippoConfig {
  const configPath = path.join(hippoRoot, 'config.json');
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<HippoConfig>;
    const basis = raw.decayBasis;
    const validBasis = basis === 'clock' || basis === 'session' || basis === 'adaptive';
    return {
      defaultHalfLifeDays: raw.defaultHalfLifeDays ?? DEFAULT_CONFIG.defaultHalfLifeDays,
      defaultBudget: raw.defaultBudget ?? DEFAULT_CONFIG.defaultBudget,
      defaultContextBudget: raw.defaultContextBudget ?? DEFAULT_CONFIG.defaultContextBudget,
      decayBasis: validBasis ? basis : DEFAULT_CONFIG.decayBasis,
      autoLearnOnSleep: raw.autoLearnOnSleep ?? DEFAULT_CONFIG.autoLearnOnSleep,
      autoShareOnSleep: raw.autoShareOnSleep ?? DEFAULT_CONFIG.autoShareOnSleep,
      autoSleep: { ...DEFAULT_CONFIG.autoSleep, ...(raw.autoSleep ?? {}) },
      embeddings: { ...DEFAULT_CONFIG.embeddings, ...(raw.embeddings ?? {}) },
      global: { ...DEFAULT_CONFIG.global, ...(raw.global ?? {}) },
      gitLearnPatterns: raw.gitLearnPatterns ?? DEFAULT_CONFIG.gitLearnPatterns,
      physics: mergePhysicsConfig(raw.physics as Partial<PhysicsConfig> | undefined),
      mmr: { ...DEFAULT_CONFIG.mmr, ...(raw.mmr ?? {}) },
      search: { ...DEFAULT_CONFIG.search, ...(raw.search ?? {}) },
      replay: { ...DEFAULT_CONFIG.replay, ...(raw.replay ?? {}) },
      autoTraceCapture: raw.autoTraceCapture ?? DEFAULT_CONFIG.autoTraceCapture,
      autoTraceWindowDays: raw.autoTraceWindowDays ?? DEFAULT_CONFIG.autoTraceWindowDays,
      pinnedInject: { ...DEFAULT_CONFIG.pinnedInject, ...(raw.pinnedInject ?? {}) },
      extraction: { ...DEFAULT_CONFIG.extraction, ...(raw.extraction ?? {}) },
      multihop: { ...DEFAULT_CONFIG.multihop, ...(raw.multihop ?? {}) },
    };
  } catch (err) {
    if (fs.existsSync(configPath)) {
      console.error(`Warning: failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(hippoRoot: string, config: HippoConfig): void {
  const configPath = path.join(hippoRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}
