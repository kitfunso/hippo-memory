import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, type HippoConfig } from '../src/config.js';
import { log } from '../src/log.js';

describe('config.pinnedInject', () => {
  it('defaults to enabled=true budget=1500', () => {
    // v0.29.1: raised from 500 to 1500 so mature installs (10+ pinned
    // memories) fit the full pinned set without silently truncating.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    try {
      const cfg = loadConfig(tmp);
      expect(cfg.pinnedInject.enabled).toBe(true);
      expect(cfg.pinnedInject.budget).toBe(1500);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts partial override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    try {
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ pinnedInject: { budget: 200 } }));
      const cfg = loadConfig(tmp);
      expect(cfg.pinnedInject.enabled).toBe(true);  // default retained
      expect(cfg.pinnedInject.budget).toBe(200);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

interface Loaded {
  cfg: HippoConfig;
  warnings: string[];
}

describe('loadConfig characterization', () => {
  function load(json: string | null): Loaded {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      if (json !== null) fs.writeFileSync(path.join(tmp, 'config.json'), json);
      const cfg = loadConfig(tmp);
      return { cfg, warnings: warn.mock.calls.map(([m]) => String(m).replace(tmp, '<root>')) };
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('returns the defaults, silently, when there is no config file', () => {
    const { cfg, warnings } = load(null);
    expect(warnings).toEqual([]);
    expect(load('{}').cfg).toEqual(cfg);
  });

  it('warns once per malformed field, in field order, and falls back for each', () => {
    const { cfg, warnings } = load(JSON.stringify({
      decayBasis: 'bogus',
      memoryValue: true,
      dormant: { enabled: 'false', retentionDays: -1 },
      churnStaleness: { enabled: 'yes' },
      defaultHalfLifeDays: 0,
      agentMemories: { tools: 'claude-code' },
      deliveryLedger: 'yes',
      pilot: { holdoutRateBp: 20000 },
    }));
    expect(warnings.map((w) => w.slice(0, w.indexOf(' must ')))).toEqual([
      'config.json\'s "memoryValue"',
      'config.json\'s "dormant.enabled"',
      'config.json\'s "dormant.retentionDays"',
      'config.json\'s "churnStaleness.enabled"',
      'config.json\'s "defaultHalfLifeDays"',
      'config.json\'s "agentMemories.tools"',
      'config.json\'s "deliveryLedger"',
      'config.json\'s "pilot"',
    ]);
    const defaults = load(null).cfg;
    expect(cfg.decayBasis).toBe(defaults.decayBasis);
    expect(cfg.memoryValue).toEqual(defaults.memoryValue);
    expect(cfg.dormant).toEqual(defaults.dormant);
    expect(cfg.churnStaleness).toEqual({ enabled: false });
    expect(cfg.defaultHalfLifeDays).toBe(defaults.defaultHalfLifeDays);
    expect(cfg.agentMemories).toEqual({ tools: [] });
    expect(cfg.deliveryLedger).toEqual({ enabled: false });
    expect(cfg.pilot).toEqual({ holdoutRateBp: 0 });
  });

  it('warns about a non-object dormant or churnStaleness block and keeps the defaults', () => {
    const { cfg, warnings } = load(JSON.stringify({ dormant: 'off', churnStaleness: 5 }));
    expect(warnings.map((w) => w.slice(0, w.indexOf(' must ')))).toEqual([
      'config.json\'s "dormant"',
      'config.json\'s "churnStaleness"',
    ]);
    expect(cfg.dormant).toEqual(load(null).cfg.dormant);
    expect(cfg.churnStaleness).toEqual(load(null).cfg.churnStaleness);
  });

  it('merges nested blocks over the defaults and keeps valid values', () => {
    const defaults = load(null).cfg;
    const { cfg, warnings } = load(JSON.stringify({
      decayBasis: 'session',
      defaultHalfLifeDays: 12,
      defaultBudget: 999,
      embeddings: { enabled: false },
      search: { rerank: 'none' },
      memoryValue: { enabled: true },
      dormant: { enabled: false, retentionDays: 0 },
      churnStaleness: { enabled: true },
      agentMemories: { tools: ['codex'] },
      deliveryLedger: { enabled: true },
      pilot: { holdoutRateBp: 2000 },
    }));
    expect(warnings).toEqual([]);
    expect(cfg).toEqual({
      ...defaults,
      decayBasis: 'session',
      defaultHalfLifeDays: 12,
      defaultBudget: 999,
      embeddings: { ...defaults.embeddings, enabled: false },
      search: { ...defaults.search, rerank: 'none' },
      memoryValue: { ...defaults.memoryValue, enabled: true },
      dormant: { enabled: false, retentionDays: 0 },
      churnStaleness: { enabled: true },
      agentMemories: { tools: ['codex'] },
      deliveryLedger: { enabled: true },
      pilot: { holdoutRateBp: 2000 },
    });
  });

  it('falls back to the defaults with one warning on unparsable or null JSON', () => {
    const defaults = load(null).cfg;
    for (const json of ['{not json', 'null']) {
      const { cfg, warnings } = load(json);
      expect(cfg).toEqual(defaults);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^failed to parse <root>[\\/]config\.json: /);
    }
  });
});
