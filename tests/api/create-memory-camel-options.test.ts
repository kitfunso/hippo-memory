import { describe, expect, it } from 'vitest';
import { createMemory } from '../../src/index.js';

describe('public createMemory camelCase options', () => {
  it('maps the nine camelCase keys onto the stored row', () => {
    const entry = createMemory('camelCase options reach the entry', {
      emotionalValence: 'negative',
      schemaFit: 0.9,
      traceOutcome: 'failure',
      sourceSessionId: 'sess-1',
      validFrom: '2026-01-02T03:04:05.000Z',
      extractedFrom: 'mem_src',
      dagLevel: 2,
      dagParentId: 'mem_parent',
      artifactRef: 'file:///a.md',
    });
    expect(entry.emotionalValence).toBe('negative');
    expect(entry.schemaFit).toBe(0.9);
    expect(entry.traceOutcome).toBe('failure');
    expect(entry.sourceSessionId).toBe('sess-1');
    expect(entry.validFrom).toBe('2026-01-02T03:04:05.000Z');
    expect(entry.extractedFrom).toBe('mem_src');
    expect(entry.dagLevel).toBe(2);
    expect(entry.dagParentId).toBe('mem_parent');
    expect(entry.artifactRef).toBe('file:///a.md');
  });

  it('drops the snake_case keys 2.x accepted, in the type and at run time', () => {
    // @ts-expect-error snake_case option keys were removed in 3.0
    const entry = createMemory('snake keys are gone', { dag_level: 3, artifact_ref: 'file:///b.md' });
    expect(entry.dagLevel).toBe(0);
    expect(entry.artifactRef).toBeNull();
  });

  it('keeps the defaults when no option is set', () => {
    const entry = createMemory('no options at all');
    expect(entry.dagLevel).toBe(0);
    expect(entry.artifactRef).toBeNull();
    expect(entry.traceOutcome).toBeNull();
    expect(entry.sourceSessionId).toBeNull();
  });
});
