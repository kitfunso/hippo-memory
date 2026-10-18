import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/cli/verbs.js';

describe('destructive verbs', () => {
  it('are the rows flagged destructive in the verb table', () => {
    const flagged = Object.entries(COMMANDS)
      .filter(([, spec]) => spec.destructive)
      .map(([name]) => name)
      .sort();
    expect(flagged).toEqual([
      'audit',
      'dedup',
      'forget',
      'invalidate',
      'projects',
      'reject',
      'resolve',
      'sleep',
      'supersede',
    ]);
  });
});
