import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, isSharedStore, _resetSharedStoreCacheForTests, type HippoConfig } from '../src/config.js';
import * as server from '../src/server.js';
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

  it('keeps deliveryLedger off unless a real boolean sits inside an object', () => {
    expect(load(null).cfg.deliveryLedger).toEqual({ enabled: false });
    expect(load(JSON.stringify({ pinnedInject: { promptRecall: false } })).cfg.deliveryLedger).toEqual({ enabled: false });
    for (const body of [{ deliveryLedger: true }, { deliveryLedger: { enabled: 'true' } }, { deliveryLedger: [true] }]) {
      const { cfg, warnings } = load(JSON.stringify(body));
      expect(cfg.deliveryLedger, JSON.stringify(body)).toEqual({ enabled: false });
      expect(warnings, JSON.stringify(body)).toHaveLength(1);
      expect(warnings[0]).toContain('deliveryLedger');
    }
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

describe('config.sharedStore', () => {
  let tmp: string;
  beforeEach(() => {
    _resetSharedStoreCacheForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-shared-'));
    return () => fs.rmSync(tmp, { recursive: true, force: true });
  });
  const writeConfig = (json: string): void => fs.writeFileSync(path.join(tmp, 'config.json'), json);

  it('reads true from config.json on both readers', () => {
    writeConfig(JSON.stringify({ sharedStore: true }));
    expect(loadConfig(tmp).sharedStore).toBe(true);
    expect(isSharedStore(tmp)).toBe(true);
  });

  it('is false when the key is absent or there is no config file', () => {
    expect(loadConfig(tmp).sharedStore).toBe(false);
    expect(isSharedStore(tmp)).toBe(false);
    writeConfig('{}');
    expect(loadConfig(tmp).sharedStore).toBe(false);
    expect(isSharedStore(tmp)).toBe(false);
  });

  it('reads a non-boolean as false with one warning', () => {
    writeConfig(JSON.stringify({ sharedStore: 'yes' }));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig(tmp).sharedStore).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('"sharedStore"');
    } finally {
      warn.mockRestore();
    }
    expect(isSharedStore(tmp)).toBe(false);
  });

  it('stays true for the process once seen, so a broken edit cannot turn it off', () => {
    writeConfig(JSON.stringify({ sharedStore: true }));
    expect(isSharedStore(tmp)).toBe(true);
    writeConfig('{not json');
    expect(isSharedStore(tmp)).toBe(true);
    _resetSharedStoreCacheForTests();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(isSharedStore(tmp)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  /** Flags `seen`, breaks its config, then asks through `other`, a second spelling of the same folder. */
  function stickyThrough(seen: string, other: string): boolean {
    writeConfig(JSON.stringify({ sharedStore: true }));
    expect(isSharedStore(seen)).toBe(true);
    writeConfig('{not json');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      return isSharedStore(other);
    } finally {
      warn.mockRestore();
    }
  }

  it('stays true under a second spelling of the same folder', () => {
    const other = process.platform === 'win32' ? `${tmp.toUpperCase()}${path.sep}` : `${tmp}${path.sep}.${path.sep}`;
    expect(stickyThrough(tmp, other)).toBe(true);
  });

  it('stays true through a symlink to the same folder', () => {
    const link = `${tmp}-link`;
    try {
      fs.symlinkSync(tmp, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      // Some boxes refuse links to a normal user; the spelling test still runs there.
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') return;
      throw err;
    }
    try {
      expect(stickyThrough(link, tmp)).toBe(true);
    } finally {
      // unlink removes the link alone on every platform; rmSync without recursive rejects a junction on some Node 24 builds.
      fs.unlinkSync(link);
    }
  });

  it('is exported from hippo-memory/server', () => {
    expect(server.isSharedStore).toBe(isSharedStore);
  });
});
