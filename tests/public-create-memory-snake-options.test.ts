import { describe, expect, it } from 'vitest';
import { createMemory } from '../src/index.js';

describe('public createMemory', () => {
  it('still accepts snake_case options and maps them onto the stored row', () => {
    const entry = createMemory('public options keep their names', {
      emotional_valence: 'negative',
      schema_fit: 0.9,
      artifact_ref: 'file:///a.md',
    });
    expect(entry.emotional_valence).toBe('negative');
    expect(entry.schema_fit).toBe(0.9);
    expect(entry.artifact_ref).toBe('file:///a.md');
  });
});
