/** How each config.json key is read: its wording when bad and its fallback. */

import {
  basisPoints,
  block,
  choice,
  count,
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
import { DEFAULT_CONFIG, type ConfigFile, type HippoConfig } from './config.js';

type ConfigKey = Exclude<keyof HippoConfig, 'runtime'>;

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

function pinnedInjectFields(read: FieldReader): HippoConfig['pinnedInject'] {
  const P = D.pinnedInject;
  return {
    enabled: read('enabled', flag(P.enabled)),
    budget: read('budget', count(P.budget)),
    skipUnchanged: read('skipUnchanged', flag(P.skipUnchanged)),
    refreshTurns: read('refreshTurns', count(P.refreshTurns)),
    // The hook turns prompt recall on only for `true`, so a malformed value reads as off, not as
    // the default.
    promptRecall: read('promptRecall', flag(false, P.promptRecall)),
    promptRecallMetric: read(
      'promptRecallMetric',
      choice(P.promptRecallMetric, 'jaccard', 'cosine'),
    ),
    promptRecallThreshold: read('promptRecallThreshold', fraction(P.promptRecallThreshold)),
    promptRecallMinShared: read('promptRecallMinShared', count(P.promptRecallMinShared)),
    promptRecallMaxItems: read('promptRecallMaxItems', count(P.promptRecallMaxItems)),
    promptRecallCandidates: read('promptRecallCandidates', count(P.promptRecallCandidates)),
  };
}

// Every top-level key loadConfig reads. A bad value warns once, in one wording, and reads as
// the fallback.
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
    // `provider` is not read here: an unknown one must reach resolveEmbeddingProvider, which
    // refuses it rather than falling back to local.
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
    block('an object like {"count": 5}', D.replay, (read) => ({
      count: read('count', count(D.replay.count)),
    })),
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

/** The config a parsed config.json gives: each key it sets over the defaults;
 * src/host/config-file.ts reads it. */
export function configOverDefaults(raw: ConfigFile): HippoConfig {
  const config: HippoConfig = { ...DEFAULT_CONFIG };
  for (const entry of CONFIG_TABLE) entry.apply(raw, config);
  return config;
}
