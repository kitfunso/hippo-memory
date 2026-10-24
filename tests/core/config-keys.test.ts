import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG, type HippoConfig } from '../../src/base/config/config.js';
import { loadConfig } from '../../src/host/config-file.js';
import { log } from '../../src/base/util/log.js';
import type { JsonValue } from '../../src/base/util/json.js';

type ConfigKey = Exclude<keyof HippoConfig, 'runtime'>;

interface KeyCase {
  key: ConfigKey;
  good: JsonValue;
  /** What loadConfig must return for `good`. */
  read: JsonValue;
  /** A value the key must refuse. */
  bad: JsonValue;
  /** For a block: one field that holds a bad value, and what that field reads as. */
  badField?: { name: string; value: JsonValue; reads?: JsonValue };
}

const defaultsOf = (key: ConfigKey): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(DEFAULT_CONFIG[key]));

const block = (key: ConfigKey, good: Record<string, JsonValue>): Pick<KeyCase, 'key' | 'good' | 'read'> => ({
  key,
  good,
  read: { ...defaultsOf(key), ...good },
});
const scalar = (key: ConfigKey, good: JsonValue): Pick<KeyCase, 'key' | 'good' | 'read'> => ({ key, good, read: good });
const enabledField = { name: 'enabled', value: 'yes' };

const CASES: KeyCase[] = [
  { ...scalar('defaultHalfLifeDays', 12), bad: 0 },
  { ...scalar('defaultBudget', 999), bad: -1 },
  { ...scalar('defaultContextBudget', 999), bad: 'big' },
  { ...scalar('decayBasis', 'session'), bad: 'bogus' },
  { ...scalar('autoLearnOnSleep', false), bad: 'no' },
  { ...scalar('autoShareOnSleep', false), bad: 1 },
  {
    ...block('autoSleep', { enabled: false, threshold: 9 }),
    bad: 7,
    badField: { name: 'threshold', value: -2, reads: 50 },
  },
  {
    ...block('embeddings', { enabled: false, provider: 'openai' }),
    bad: 'on',
    badField: { name: 'hybridWeight', value: 2, reads: DEFAULT_CONFIG.embeddings.hybridWeight },
  },
  { ...block('global', { enabled: false }), bad: true, badField: enabledField },
  { ...scalar('gitLearnPatterns', ['fix']), bad: 'fix' },
  // A config file keeps the snake_case physics keys; each reads into its camelCase field.
  {
    key: 'physics',
    good: { G_query: 3 },
    read: { ...defaultsOf('physics'), gQuery: 3 },
    bad: [],
    badField: { name: 'dt', value: 'fast', reads: 0.1 },
  },
  { ...block('mmr', { lambda: 0.2 }), bad: 'on', badField: { name: 'lambda', value: 2, reads: 0.7 } },
  { ...block('search', { localBump: 2 }), bad: null, badField: { name: 'localBump', value: 0, reads: 1.2 } },
  { ...block('replay', { count: 0 }), bad: 3, badField: { name: 'count', value: 'many', reads: 5 } },
  { ...scalar('autoTraceCapture', false), bad: 'no' },
  { ...scalar('autoTraceWindowDays', 3), bad: -1 },
  {
    ...block('pinnedInject', { budget: 200 }),
    bad: 'all',
    badField: { name: 'promptRecallMetric', value: 'dice', reads: 'jaccard' },
  },
  { ...scalar('contextProjectIsolation', false), bad: 'off' },
  {
    ...block('extraction', { enabled: false }),
    bad: 'on',
    badField: { name: 'model', value: 4, reads: 'claude-sonnet-4-6' },
  },
  { ...block('multihop', { enabled: true }), bad: 1, badField: enabledField },
  {
    ...block('salience', { recentWindow: 3 }),
    bad: 'on',
    badField: { name: 'overlapThreshold', value: 7, reads: 0.6 },
  },
  { ...block('ambient', { enabled: false }), bad: 'no', badField: enabledField },
  { ...block('memoryValue', { enabled: true }), bad: true, badField: enabledField },
  {
    ...block('dormant', { enabled: false, retentionDays: 0 }),
    bad: 'off',
    badField: { name: 'retentionDays', value: -1, reads: 180 },
  },
  { ...block('churnStaleness', { enabled: true }), bad: 5, badField: enabledField },
  {
    ...block('agentMemories', { tools: ['codex'] }),
    bad: 'codex',
    badField: { name: 'tools', value: 'codex', reads: [] },
  },
  { ...block('deliveryLedger', { enabled: true }), bad: [true], badField: enabledField },
  {
    ...block('pilot', { holdoutRateBp: 2000 }),
    bad: 2000,
    badField: { name: 'holdoutRateBp', value: 10001, reads: 0 },
  },
  {
    ...block('projectIdentity', { remote: false }),
    bad: 'git',
    badField: { name: 'remote', value: 'no', reads: true },
  },
  { ...scalar('sharedStore', true), bad: 'yes' },
  {
    ...block('vectorGraph', { maxVectors: 50_000 }),
    bad: 200_000,
    badField: { name: 'maxVectors', value: 'many', reads: 200_000 },
  },
];

interface Loaded {
  cfg: HippoConfig;
  warnings: string[];
}

function load(body: JsonValue | undefined): Loaded {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-keys-'));
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(body === undefined ? {} : body));
    return { cfg: loadConfig(tmp), warnings: warn.mock.calls.map(([message]) => String(message)) };
  } finally {
    warn.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const WARNING = /^config\.json's "[\w.]+" must be .+ \(got .+\) - using .+\.$/;

describe('every top-level config key is checked', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has a case for each key loadConfig reads', () => {
    expect(CASES.map((c) => c.key).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
    expect(CASES).toHaveLength(31);
  });

  describe.each(CASES)('$key', (c) => {
    it('reads a good value without a warning', () => {
      const { cfg, warnings } = load({ [c.key]: c.good });
      expect(warnings).toEqual([]);
      expect(cfg[c.key]).toEqual(c.read);
    });

    it('warns once, in the shared wording, for a bad value and reads the default', () => {
      const { cfg, warnings } = load({ [c.key]: c.bad });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(WARNING);
      expect(warnings[0]).toContain(`"${c.key}"`);
      expect(cfg[c.key]).toEqual(DEFAULT_CONFIG[c.key]);
    });

    it('reads the default, silently, when the key is absent', () => {
      const { cfg, warnings } = load({});
      expect(warnings).toEqual([]);
      expect(cfg[c.key]).toEqual(DEFAULT_CONFIG[c.key]);
    });
  });

  describe.each(CASES.flatMap((c) => (c.badField === undefined ? [] : [{ key: c.key, field: c.badField }])))(
    '$key block',
    ({ key, field }) => {
      it(`names ${field.name} when only that field holds a bad value`, () => {
        const { cfg, warnings } = load({ [key]: { [field.name]: field.value } });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(WARNING);
        expect(warnings[0]).toContain(`"${key}.${field.name}"`);
        const base = defaultsOf(key);
        expect(cfg[key]).toEqual({ ...base, [field.name]: field.reads ?? base[field.name] });
      });
    },
  );

  it('reads a malformed pinnedInject.promptRecall as off, with one warning', () => {
    const { cfg, warnings } = load({ pinnedInject: { promptRecall: 'false' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(WARNING);
    expect(warnings[0]).toContain('"pinnedInject.promptRecall"');
    expect(cfg.pinnedInject.promptRecall).toBe(false);
  });

  it('lets an unknown embeddings.provider through, so the provider refuses it instead of falling back to local', () => {
    const { cfg, warnings } = load({ embeddings: { provider: 'opneai' } });
    expect(warnings).toEqual([]);
    expect(cfg.embeddings.provider).toBe('opneai');
  });

  it('keeps a block field it does not name, as written', () => {
    const { cfg, warnings } = load({ search: { rerank: 'none' } });
    expect(warnings).toEqual([]);
    expect(cfg.search).toEqual({ ...DEFAULT_CONFIG.search, rerank: 'none' });
  });
});
