// assertCopyRight: promote and share copy a restricted row only for an admin or the member who owns it.
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../src/base/errors/api-errors.js';
import { assertCopyRight, type ScopeReader, type WrittenRow } from '../../src/base/scope/recall-scope.js';

const S = 'slack:private:c1';

const granted: ScopeReader = { ownScope: 'personal:private:oid-m', role: 'member', grants: [S], owner: 'oid-m' };
const ungranted: ScopeReader = { ownScope: null, role: 'member' };
const admin: ScopeReader = { ownScope: null, role: 'admin' };

const restricted: WrittenRow = { scope: S, owner: 'oid-o' };
const ownerless: WrittenRow = { scope: S, owner: null };
const open: WrittenRow = { scope: 'team', owner: 'oid-o' };

function copy(reader: ScopeReader, row: WrittenRow | undefined): () => void {
  return () => assertCopyRight(reader, row, 'm1', 'memory not found: m1');
}

describe('assertCopyRight', () => {
  it('lets an admin copy a restricted row that records no writer', () => {
    expect(copy(admin, ownerless)).not.toThrow();
  });

  it('refuses a member who only holds a read grant, naming the key that can copy', () => {
    expect(copy(granted, restricted)).toThrow(ForbiddenError);
    expect(copy(granted, restricted)).toThrow(
      'memory m1 was written by someone else: copy it with the key that wrote it or an admin key',
    );
  });

  it('names an admin key alone for a restricted row that records no writer', () => {
    expect(copy(granted, ownerless)).toThrow(ForbiddenError);
    expect(copy(granted, ownerless)).toThrow('memory m1 records no writer: copy it with an admin key');
  });

  it('keeps an open row open to any member who reaches it', () => {
    expect(copy(granted, open)).not.toThrow();
    expect(copy(ungranted, { scope: null, owner: null })).not.toThrow();
  });
});
