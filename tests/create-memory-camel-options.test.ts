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

  it('still maps every snake_case key', () => {
    const entry = createMemory('snake_case options stay until 3.0', {
      emotional_valence: 'positive',
      schema_fit: 0.2,
      trace_outcome: 'success',
      source_session_id: 'sess-2',
      valid_from: '2026-02-03T04:05:06.000Z',
      extracted_from: 'mem_old',
      dag_level: 3,
      dag_parent_id: 'mem_up',
      artifact_ref: 'file:///b.md',
    });
    expect(entry.emotional_valence).toBe('positive');
    expect(entry.schema_fit).toBe(0.2);
    expect(entry.trace_outcome).toBe('success');
    expect(entry.source_session_id).toBe('sess-2');
    expect(entry.valid_from).toBe('2026-02-03T04:05:06.000Z');
    expect(entry.extracted_from).toBe('mem_old');
    expect(entry.dag_level).toBe(3);
    expect(entry.dag_parent_id).toBe('mem_up');
    expect(entry.artifact_ref).toBe('file:///b.md');
  });

  it('lets the camelCase key win when both spellings are set', () => {
    const entry = createMemory('both spellings set', {
      emotionalValence: 'negative',
      emotional_valence: 'positive',
      dagLevel: 4,
      dag_level: 1,
      artifactRef: 'file:///camel.md',
      artifact_ref: 'file:///snake.md',
    });
    expect(entry.emotional_valence).toBe('negative');
    expect(entry.dag_level).toBe(4);
    expect(entry.artifact_ref).toBe('file:///camel.md');
  });

  it('keeps the defaults when no option is set', () => {
    const entry = createMemory('no options at all');
    expect(entry.dag_level).toBe(0);
    expect(entry.artifact_ref).toBeNull();
    expect(entry.trace_outcome).toBeNull();
    expect(entry.source_session_id).toBeNull();
  });
});
