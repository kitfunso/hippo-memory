import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/cli.js';

const argv = (...rest: string[]) => ['node', 'hippo', ...rest];

describe('parseArgs boolean-flag allowlist', () => {
  it('--dry-run followed by a positional keeps the positional', () => {
    const { command, args, flags } = parseArgs(argv('invalidate', '--dry-run', 'REST API'));
    expect(command).toBe('invalidate');
    expect(flags['dry-run']).toBe(true);
    expect(args).toEqual(['REST API']);
  });

  it('positional before --dry-run parses identically', () => {
    const { args, flags } = parseArgs(argv('invalidate', 'REST API', '--dry-run'));
    expect(flags['dry-run']).toBe(true);
    expect(args).toEqual(['REST API']);
  });

  it('--dry-run composes with a value flag', () => {
    const { args, flags } = parseArgs(argv('invalidate', '--dry-run', '--id', 'mem_abc123'));
    expect(flags['dry-run']).toBe(true);
    expect(flags['id']).toBe('mem_abc123');
    expect(args).toEqual([]);
  });

  it('non-allowlisted flags keep value semantics', () => {
    const { args, flags } = parseArgs(argv('invalidate', '--reason', 'migrated away', 'pattern'));
    expect(flags['reason']).toBe('migrated away');
    expect(args).toEqual(['pattern']);
  });
});
