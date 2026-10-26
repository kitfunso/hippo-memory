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
});
