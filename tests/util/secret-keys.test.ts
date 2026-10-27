// A key column refuses a secret-shaped value and accepts every id shape hippo makes or a hook payload carries.
import { describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { generateId } from '../../src/base/memory/entry.js';
import { refuseSecretKeys } from '../../src/base/records/secret-keys.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = (): string =>
  String(randomInt(8)) + Array.from({ length: 25 }, () => CROCKFORD[randomInt(CROCKFORD.length)]).join('');

describe('refuseSecretKeys', () => {
  it('accepts hippo ids, UUIDs, ULIDs and the scopes, types and runtimes callers send', () => {
    const keys: string[] = [
      's1',
      'session_complete',
      'repo',
      'slack:private:C1',
      'personal:private:oid-a',
      'claude-code',
      'effort',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ];
    for (let i = 0; i < 500; i++) {
      keys.push(randomUUID(), ulid(), randomUUID().toUpperCase());
      for (const prefix of ['mem', 'card', 'g', 'sem', 'cmp', 'rp']) {
        keys.push(generateId(prefix), generateId(prefix, 32));
      }
    }
    for (const key of keys) expect(() => refuseSecretKeys({ sessionId: key }), key).not.toThrow();
  });

  it('refuses a secret-shaped value, naming the field and never the value', () => {
    const token = runtimeJoin('ghp_', 'k4'.repeat(18));
    const refuse = (): void => refuseSecretKeys({ sessionId: 's1', taskId: `t-${token}` });
    expect(refuse).toThrow(BadRequestError);
    expect(refuse).toThrow(/^taskId holds secret-shaped text/);
    expect(refuse).not.toThrow(token);
  });

  it('lets an absent key through', () => {
    expect(() => refuseSecretKeys({ sessionId: undefined, scope: null, taskId: '' })).not.toThrow();
  });
});
