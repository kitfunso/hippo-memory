// Each verb names the optional store groups it reaches, and main refuses one whose group the store lacks before the
// verb opens anything, with the StoreNotPortedError an unported store path throws, which runCli prints and exits 1 on.
import { describe, expect, it } from 'vitest';
import { StoreNotPortedError } from '../../src/base/util/store-blocked.js';
import { assertVerbPorted, CLI_STORE, COMMANDS, type ServedGroups } from '../../src/surface/cli/verbs.js';

// A store the CLI could open one day: every optional group but objects.
const withoutObjects: ServedGroups = {
  kind: 'port-only',
  groups: CLI_STORE.groups.filter((group) => group !== 'objects'),
};

describe('verb groups', () => {
  it('every verb runs on the store the CLI opens, which sets every optional group', () => {
    for (const row of Object.values(COMMANDS)) expect(() => assertVerbPorted(row, CLI_STORE)).not.toThrow();
  });

  it('each object verb refuses a store without the objects group, naming the store and the group', () => {
    const objectVerbs = Object.entries(COMMANDS).filter(([, row]) => row.needs?.includes('objects'));
    expect(objectVerbs.map(([name]) => name)).toEqual([
      'predict',
      'decide',
      'incident',
      'process',
      'policy',
      'skill',
      'brief',
      'note',
    ]);
    for (const [, row] of objectVerbs) {
      expect(() => assertVerbPorted(row, withoutObjects)).toThrow(new StoreNotPortedError('port-only', 'objects'));
    }
  });

  it('a recall, remember or context verb names no group, so it runs on any store', () => {
    for (const name of ['recall', 'remember', 'context'] as const) {
      expect(COMMANDS[name].needs).toBeUndefined();
      expect(() => assertVerbPorted(COMMANDS[name], { kind: 'port-only', groups: [] })).not.toThrow();
    }
  });

  it('every row with needs refuses a store without any one of its groups, naming the store kind and that group', () => {
    const rows = Object.values(COMMANDS).filter((row) => (row.needs ?? []).length > 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const group of row.needs ?? []) {
        const without: ServedGroups = { kind: 'port-only', groups: CLI_STORE.groups.filter((g) => g !== group) };
        expect(() => assertVerbPorted(row, without)).toThrow(new StoreNotPortedError('port-only', group));
      }
    }
  });

  it('every verb whose code reaches one of the five groups that left the required store names it', () => {
    // The feature groups each verb's code under src/surface/cli reads, found by grep, so a verb that reads one names it.
    const reached = {
      status: ['reports'],
      provenance: ['reports'],
      drill: ['dagReads'],
      assemble: ['dagReads'],
      'correction-latency': ['reports'],
      tokens: ['reports'],
      failures: ['reports'],
      'daily-runner': ['reports'],
      dedup: ['reports'],
      sleep: ['graphReads'],
      graph: ['graphReads'],
      wm: ['sessions'],
      snapshot: ['sessions'],
      session: ['sessions'],
      handoff: ['sessions'],
      current: ['sessions'],
      'compact-resume': ['sessions'],
      goal: ['goals'],
      '__session-end-worker': ['sessions', 'reports'],
    } as const;
    const rows = new Map(Object.entries(COMMANDS));
    for (const [verb, groups] of Object.entries(reached)) {
      expect([verb, groups.filter((g) => !(rows.get(verb)?.needs ?? []).some((n) => n === g))]).toEqual([verb, []]);
    }
  });
});
