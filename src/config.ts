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
}

const DEFAULT_CONFIG: HippoConfig = {
  defaultHalfLifeDays: 7,
  defaultBudget: 4000,
  defaultContextBudget: 3000,
  decayBasis: 'adaptive',
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
      autoSleep: { ...DEFAULT_CONFIG.autoSleep, ...(raw.autoSleep ?? {}) },
      embeddings: { ...DEFAULT_CONFIG.embeddings, ...(raw.embeddings ?? {}) },
      global: { ...DEFAULT_CONFIG.global, ...(raw.global ?? {}) },
      gitLearnPatterns: raw.gitLearnPatterns ?? DEFAULT_CONFIG.gitLearnPatterns,
      physics: mergePhysicsConfig(raw.physics as Partial<PhysicsConfig> | undefined),
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
