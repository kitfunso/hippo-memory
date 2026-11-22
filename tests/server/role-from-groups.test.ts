// roleFromGroups maps an IdP groups claim onto the role ladder; the highest match wins.
import { describe, expect, it } from 'vitest';
import {
  GROUPS_CLAIM_TOO_LONG,
  roleFromGroups,
  type JsonValue,
  type Role,
  type RoleFromGroups,
} from '../../src/server.js';

const MAPPING = { viewer: ['Readers'], editor: ['Writers'], admin: ['Admins'] };

const roleOf = (claim: JsonValue | undefined, fallback: Role = 'member'): RoleFromGroups =>
  roleFromGroups(claim, MAPPING, fallback);

describe('the highest matching group wins', () => {
  it.each([
    [['Readers', 'Admins'], 'admin'],
    [['Writers', 'Admins'], 'admin'],
    [['Readers', 'Writers', 'Admins'], 'admin'],
    [['Readers', 'Writers'], 'member'],
    [['Readers'], 'viewer'],
  ])('%j gives %s', (claim, role) => {
    expect(roleOf(claim, 'viewer')).toEqual({ role });
  });

  it('gives the fallback when no group matches, whichever fallback the deployment picks', () => {
    expect(roleOf(['Other'], 'member')).toEqual({ role: 'member' });
    expect(roleOf(['Other'], 'viewer')).toEqual({ role: 'viewer' });
  });
});

describe('the claim shapes', () => {
  it.each([[undefined], [null], [42], [true], [{}]])('%j gives the fallback', (claim) => {
    expect(roleOf(claim, 'viewer')).toEqual({ role: 'viewer' });
  });

  it('reads a lone string as one group', () => {
    expect(roleOf('Admins')).toEqual({ role: 'admin' });
  });

  it('keeps only the string entries of an array', () => {
    expect(roleOf(['x', 1, null, 'Admins'])).toEqual({ role: 'admin' });
  });

  it.each([['admins'], [' Admins'], ['Admins ']])('does not match %j', (group) => {
    expect(roleOf([group], 'viewer')).toEqual({ role: 'viewer' });
  });
});

describe('the size cap', () => {
  const filler = (count: number): string[] => Array.from({ length: count }, (_, i) => `g-secret-${i}`);

  it('takes 1024 entries', () => {
    expect(roleOf([...filler(1023), 'Admins'])).toEqual({ role: 'admin' });
  });

  it('refuses 1025 strings, and 1025 numbers, before it reads any entry', () => {
    expect(roleOf([...filler(1024), 'Admins'])).toEqual({ refused: GROUPS_CLAIM_TOO_LONG });
    expect(roleOf(Array.from({ length: 1025 }, (_, i) => i))).toEqual({ refused: GROUPS_CLAIM_TOO_LONG });
    expect(GROUPS_CLAIM_TOO_LONG).toBe('groups claim lists more than 1024 groups');
    expect(GROUPS_CLAIM_TOO_LONG).not.toContain('g-secret-');
  });
});
