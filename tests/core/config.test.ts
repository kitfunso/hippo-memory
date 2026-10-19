import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  configReader,
  loadConfig,
  isSharedStore,
  type HippoConfig,
} from '../../src/core/config.js';
import * as storeKit from '../../src/entry/store-kit.js';
import { log } from '../../src/util/log.js';

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
      expect(cfg.pinnedInject.enabled).toBe(true); // default retained
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
    const { cfg, warnings } = load(
      JSON.stringify({
        decayBasis: 'bogus',
        memoryValue: true,
        dormant: { enabled: 'false', retentionDays: -1 },
        churnStaleness: { enabled: 'yes' },
        defaultHalfLifeDays: 0,
        agentMemories: { tools: 'claude-code' },
        deliveryLedger: 'yes',
        pilot: { holdoutRateBp: 20000 },
      }),
    );
    expect(warnings.map((w) => w.slice(0, w.indexOf(' must ')))).toEqual([
      'config.json\'s "defaultHalfLifeDays"',
      'config.json\'s "decayBasis"',
      'config.json\'s "memoryValue"',
      'config.json\'s "dormant.enabled"',
      'config.json\'s "dormant.retentionDays"',
      'config.json\'s "churnStaleness.enabled"',
      'config.json\'s "agentMemories.tools"',
      'config.json\'s "deliveryLedger"',
      'config.json\'s "pilot.holdoutRateBp"',
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
    const { cfg, warnings } = load(
      JSON.stringify({
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
      }),
    );
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
    expect(load(JSON.stringify({ pinnedInject: { promptRecall: false } })).cfg.deliveryLedger).toEqual({
      enabled: false,
    });
    for (const body of [
      { deliveryLedger: true },
      { deliveryLedger: { enabled: 'true' } },
      { deliveryLedger: [true] },
    ]) {
      const { cfg, warnings } = load(JSON.stringify(body));
      expect(cfg.deliveryLedger, JSON.stringify(body)).toEqual({ enabled: false });
      expect(warnings, JSON.stringify(body)).toHaveLength(1);
      expect(warnings[0]).toContain('deliveryLedger');
    }
  });

  it('throws with the file path and the parse error on unparsable JSON, and names a non-object', () => {
    expect(() => load('{not json')).toThrow(/config\.json could not be loaded: .*(JSON|property name)/);
    for (const json of ['null', '[]', '"tea"']) {
      expect(() => load(json), json).toThrow(/config\.json must hold a JSON object/);
    }
  });
});

describe('config.sharedStore', () => {
  let tmp: string;
  beforeEach(() => {
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

  it('stays true for the process once seen, so a broken edit cannot turn it off', async () => {
    writeConfig(JSON.stringify({ sharedStore: true }));
    expect(isSharedStore(tmp)).toBe(true);
    writeConfig('{not json');
    expect(isSharedStore(tmp)).toBe(true);
    // A fresh module graph stands in for the next process, which has not seen the folder.
    vi.resetModules();
    const nextProcess = await import('../../src/core/config.js');
    expect(() => nextProcess.isSharedStore(tmp)).toThrow(/config\.json could not be loaded/);
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

  it('is exported from hippo-memory/store-kit', () => {
    expect(storeKit.isSharedStore).toBe(isSharedStore);
  });
});

describe('config.json is parsed once per file version, per reader', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-cache-'));
    file = path.join(tmp, 'config.json');
    return () => {
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    };
  });

  /** Reads of this folder's config.json while `run` runs. */
  function configReads(run: () => void): number {
    const read = vi.spyOn(fsDefault, 'readFileSync');
    // config.ts imports fs as a namespace, which sees the spy only after this sync.
    syncBuiltinESMExports();
    try {
      run();
      return read.mock.calls.filter(([target]) => String(target) === file).length;
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
    }
  }

  /** Writes `budget` at a fixed mtime, so two budgets of one length leave the same stamp. */
  function writeAtFixedStamp(budget: number): void {
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget } }));
    fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  }

  it('a reader parses an unchanged file once, however often it is asked', () => {
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 200 } }));
    const read = configReader();
    const budgets: number[] = [];
    const reads = configReads(() => {
      for (let i = 0; i < 5; i++) budgets.push(read(tmp).pinnedInject.budget);
    });
    expect(budgets).toEqual([200, 200, 200, 200, 200]);
    expect(reads).toBe(1);
  });

  it('loadConfig holds no parse: each call reads the file', () => {
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 200 } }));
    expect(
      configReads(() => {
        for (let i = 0; i < 3; i++) loadConfig(tmp);
      }),
    ).toBe(3);
  });

  it('two roots in one process keep their own parses, so neither answers from the other', () => {
    writeAtFixedStamp(200);
    const server = configReader();
    expect(server(tmp).pinnedInject.budget).toBe(200);
    writeAtFixedStamp(300);
    const cli = configReader();
    expect(cli(tmp).pinnedInject.budget).toBe(300);
    // The first root's parse is its own: the stamp it keyed on is unchanged, and the second root's read never reached it.
    expect(server(tmp).pinnedInject.budget).toBe(200);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-cache-other-'));
    try {
      fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({ pinnedInject: { budget: 9 } }));
      expect(configReader()(other).pinnedInject.budget).toBe(9);
      expect(cli(tmp).pinnedInject.budget).toBe(300);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('a reader shows an edit on the next call, even one of the same length', () => {
    const read = configReader();
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 200 } }));
    expect(read(tmp).pinnedInject.budget).toBe(200);
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 4321 } }));
    expect(read(tmp).pinnedInject.budget).toBe(4321);
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 300 } }));
    fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    expect(read(tmp).pinnedInject.budget).toBe(300);
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 301 } }));
    fs.utimesSync(file, new Date('2020-01-01T00:00:05Z'), new Date('2020-01-01T00:00:05Z'));
    expect(read(tmp).pinnedInject.budget).toBe(301);
  });

  it('a reader reads no file while it is missing, then picks it up once created, and drops it once removed', () => {
    const read = configReader();
    const reads = configReads(() => {
      expect(read(tmp).pinnedInject.budget).toBe(1500);
      expect(read(tmp).pinnedInject.budget).toBe(1500);
    });
    expect(reads).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ pinnedInject: { budget: 77 } }));
    expect(read(tmp).pinnedInject.budget).toBe(77);
    fs.rmSync(file);
    expect(read(tmp).pinnedInject.budget).toBe(1500);
  });

  it('both hand each caller its own object, so a caller that sets a field changes no later answer', () => {
    fs.writeFileSync(file, JSON.stringify({ sharedStore: true }));
    for (const load of [loadConfig, configReader()]) {
      const first = load(tmp);
      first.sharedStore = false;
      expect(load(tmp).sharedStore).toBe(true);
      const defaults = load(path.join(tmp, 'absent'));
      defaults.sharedStore = true;
      expect(load(path.join(tmp, 'absent')).sharedStore).toBe(false);
    }
  });

  it('isSharedStore reads an unchanged not-shared file once, and sees the edit that shares it', () => {
    fs.writeFileSync(file, '{}');
    const answers: boolean[] = [];
    const reads = configReads(() => {
      for (let i = 0; i < 5; i++) answers.push(isSharedStore(tmp));
    });
    expect(answers).toEqual([false, false, false, false, false]);
    expect(reads).toBe(1);
    fs.writeFileSync(file, JSON.stringify({ sharedStore: true }));
    expect(isSharedStore(tmp)).toBe(true);
  });
});
