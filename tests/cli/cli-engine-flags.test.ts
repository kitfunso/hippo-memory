// engineFlags and the boolean readers answer the same for `--flag`, `--flag=false` and `--no-flag`.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli.js';
import { DEFAULT_CONFIG } from '../../src/base/config/config.js';
import { engineFlags, flagValueless, hasFlag } from '../../src/surface/cli/flag-values.js';

const flagsOf = (...rest: string[]) => parseArgs(['node', 'hippo', 'recall', ...rest]).flags;
const engine = (...rest: string[]) => engineFlags(flagsOf(...rest), DEFAULT_CONFIG);

describe('engineFlags', () => {
  it('reads no flag as the config defaults', () => {
    expect(engine()).toMatchObject({
      mmr: DEFAULT_CONFIG.mmr.enabled,
      localBump: DEFAULT_CONFIG.search.localBump,
    });
  });

  it('--no-mmr turns MMR off and --equal-sources sets the bump to 1', () => {
    expect(engine('--no-mmr').mmr).toBe(false);
    expect(engine('--equal-sources').localBump).toBe(1);
  });

  it('a valued switch reads as on, as a bare one does', () => {
    expect(engine('--equal-sources=false').localBump).toBe(1);
    expect(engine('--no-mmr=false').mmr).toBe(false);
  });

  it('--no-equal-sources is a flag of its own and leaves the config defaults', () => {
    expect(engine('--no-equal-sources').localBump).toBe(DEFAULT_CONFIG.search.localBump);
  });
});

describe('presence and missing value', () => {
  it('tells a typed flag from a bare one', () => {
    const flags = flagsOf('--layer', 'semantic', '--outcome');
    expect([hasFlag(flags, 'layer'), flagValueless(flags, 'layer')]).toEqual([true, false]);
    expect([hasFlag(flags, 'outcome'), flagValueless(flags, 'outcome')]).toEqual([true, true]);
    expect([hasFlag(flags, 'goal'), flagValueless(flags, 'goal')]).toEqual([false, false]);
  });
});
