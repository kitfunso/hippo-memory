// assertCopyRight: promote and share copy a restricted row only for an admin or the member who owns it.
import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError } from '../../src/base/errors/api-errors.js';
import {
  assertCopyRight,
  assertWriteRight,
  type ScopeReader,
  type WrittenRow,
} from '../../src/base/scope/recall-scope.js';

const S = 'slack:private:c1';
const MISSING = 'Memory not found: m1';

const owner: ScopeReader = { ownScope: 'personal:private:oid-o', role: 'member', grants: [S], owner: 'oid-o' };
const granted: ScopeReader = { ownScope: 'personal:private:oid-m', role: 'member', grants: [S], owner: 'oid-m' };
const ungranted: ScopeReader = { ownScope: null, role: 'member' };
const admin: ScopeReader = { ownScope: null, role: 'admin' };

const restricted: WrittenRow = { scope: S, owner: 'oid-o' };
const ownerless: WrittenRow = { scope: S, owner: null };
const open: WrittenRow = { scope: 'team', owner: 'oid-o' };

function copy(reader: ScopeReader, row: WrittenRow | undefined): () => void {
  return () => assertCopyRight(reader, row, 'm1', MISSING);
}

describe('assertCopyRight', () => {
  it('lets the owner and an admin copy a restricted row', () => {
    expect(copy(owner, restricted)).not.toThrow();
    expect(copy(admin, restricted)).not.toThrow();
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

  it('reads an absent row and an out-of-reach row alike, with the missing text', () => {
    for (const fn of [copy(granted, undefined), copy(ungranted, restricted)]) {
      expect(fn).toThrow(NotFoundError);
      expect(fn).toThrow(MISSING);
    }
  });

  it('keeps an open row open to any member who reaches it', () => {
    expect(copy(granted, open)).not.toThrow();
    expect(copy(ungranted, { scope: null, owner: null })).not.toThrow();
  });

  it('leaves the change refusal text of assertWriteRight as it was', () => {
    expect(() => assertWriteRight(granted, restricted, 'm1', MISSING)).toThrow(
      'memory m1 was written by someone else: change it with the key that wrote it or an admin key',
    );
  });
});
