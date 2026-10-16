// The list-limit rule lives once in util/limits.ts; the CLI and HTTP parsers are thin adapters over it.
import { describe, it, expect, vi } from 'vitest';
import { resolveListLimit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../src/util/limits.js';
import { pct } from '../src/util/format.js';
import { parseListLimit as parseHttpLimit } from '../src/server/validation.js';
import { parseListLimit as parseCliLimit } from '../src/cli/flag-values.js';
import { CliExit } from '../src/cli/exit.js';

describe('resolveListLimit', () => {
  it('falls back to the default when absent', () => {
    expect(resolveListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit(undefined, 7)).toBe(7);
  });
  it('passes positive integers up to the ceiling and rejects the rest', () => {
    expect(resolveListLimit(5, 100, 10)).toBe(5);
    expect(resolveListLimit(10, 100, 10)).toBe(10);
    for (const bad of [0, -1, 1.5, NaN, Infinity, 11]) expect(resolveListLimit(bad, 100, 10)).toBeUndefined();
  });
  it('has no ceiling unless one is named', () => {
    expect(resolveListLimit(5_000_000)).toBe(5_000_000);
  });
});

describe('HTTP adapter', () => {
  it('keeps its outputs and message', () => {
    expect(parseHttpLimit(null)).toBe(DEFAULT_LIST_LIMIT);
    expect(parseHttpLimit('25')).toBe(25);
    expect(parseHttpLimit(String(MAX_LIST_LIMIT))).toBe(MAX_LIST_LIMIT);
    for (const bad of ['0', '-3', '1.5', 'abc', '', String(MAX_LIST_LIMIT + 1)]) {
      expect(() => parseHttpLimit(bad)).toThrow(`limit must be a positive integer <= ${MAX_LIST_LIMIT}`);
    }
  });
});

describe('CLI adapter', () => {
  it('keeps its outputs and exits on junk', () => {
    expect(parseCliLimit({})).toBe(DEFAULT_LIST_LIMIT);
    expect(parseCliLimit({ limit: '25' })).toBe(25);
    expect(parseCliLimit({ limit: '5000' })).toBe(5000);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['0', '-3', 'abc', '12abc', ' 12', true]) {
      expect(() => parseCliLimit({ limit: bad })).toThrow(CliExit);
    }
    err.mockRestore();
  });
});

describe('pct', () => {
  it('formats a fraction with one decimal', () => {
    expect(pct(0.256)).toBe('25.6%');
    expect(pct(0)).toBe('0.0%');
  });
});
