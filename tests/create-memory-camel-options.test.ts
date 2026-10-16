import { describe, expect, it } from 'vitest';
import { createMemory } from '../src/index.js';

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
    expect(entry.emotional_valence).toBe('negative');
    expect(entry.schema_fit).toBe(0.9);
    expect(entry.trace_outcome).toBe('failure');
    expect(entry.source_session_id).toBe('sess-1');
    expect(entry.valid_from).toBe('2026-01-02T03:04:05.000Z');
    expect(entry.extracted_from).toBe('mem_src');
    expect(entry.dag_level).toBe(2);
    expect(entry.dag_parent_id).toBe('mem_parent');
    expect(entry.artifact_ref).toBe('file:///a.md');
  });

  it('drops the snake_case keys 2.x accepted, in the type and at run time', () => {
    // @ts-expect-error snake_case option keys were removed in 3.0
    const entry = createMemory('snake keys are gone', { dag_level: 3, artifact_ref: 'file:///b.md' });
    expect(entry.dag_level).toBe(0);
    expect(entry.artifact_ref).toBeNull();
  });

  it('keeps the defaults when no option is set', () => {
    const entry = createMemory('no options at all');
    expect(entry.dag_level).toBe(0);
    expect(entry.artifact_ref).toBeNull();
    expect(entry.trace_outcome).toBeNull();
    expect(entry.source_session_id).toBeNull();
  });
});
