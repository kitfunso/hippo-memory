// E10 lane A: scopeAdmitSql, run on a real store's memories table, admits exactly what passesScopeFilterForRecall admits.
import { describe, it, expect, beforeAll } from 'vitest';
import { closeHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { passesScopeFilterForRecall } from '../../src/core/recall-scope.js';
import { scopeAdmitSql } from '../../src/store/sqlite/rule-sql.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { openStore } from '../../src/store/sqlite/handles.js';

const OWN_A = 'personal:private:a';
const SCOPES: ReadonlyArray<string | null> = [
  null,
  '',
  'team',
  'slack:private:C1',
  'SLACK:PRIVATE:x',
  'unknown:legacy',
  OWN_A,
  'personal:private:b',
  'Personal:private:a',
];

describe('scopeAdmitSql parity on a real store', () => {
  let root: string;
  let stored: Array<{ id: string; scope: string | null }>;

  function admittedBySql(col: '' | 'm.', ownScope?: string, and = ''): string[] {
    const { sql, params } = scopeAdmitSql(col, ownScope);
    const db = openStore(root);
    try {
      // SAFETY: the SELECT names only the id column.
      const rows = db
        .prepare(`SELECT id FROM memories m WHERE m.tenant_id = ? ${and}AND ${sql}`)
        .all('default', ...params) as Array<{ id: string }>;
      return rows.map((r) => r.id).sort();
    } finally {
      closeHippoDb(db);
    }
  }

  beforeAll(() => {
    root = makeRoot('scope-parity');
    SCOPES.forEach((scope, i) =>
      writeEntry(root, createMemory(`parity row number ${i}`, { scope, tenantId: 'default' })),
    );
    const db = openStore(root);
    try {
      // SAFETY: the SELECT names the id and scope columns.
      stored = db.prepare('SELECT id, scope FROM memories').all() as Array<{ id: string; scope: string | null }>;
    } finally {
      closeHippoDb(db);
    }
  });

  it('stores every scope as written, so the parity runs over the whole list', () => {
    expect(stored.map((r) => r.scope).sort()).toEqual([...SCOPES].sort());
  });

  it.each([
    ['', undefined],
    ['m.', undefined],
    ['', OWN_A],
    ['m.', OWN_A],
    ['m.', 'Personal:private:a'],
  ] as const)('col %j, ownScope %s', (col, ownScope) => {
    const expected = stored
      .filter((r) => passesScopeFilterForRecall(r.scope, undefined, ownScope))
      .map((r) => r.id)
      .sort();
    expect(admittedBySql(col, ownScope)).toEqual(expected);
  });

  it('binds the owner, so LIKE wildcards in it match nothing extra', () => {
    const { sql, params } = scopeAdmitSql('', 'personal:private:%');
    expect(sql).not.toContain('personal:private:%');
    expect(params[params.length - 1]).toBe('personal:private:%');
    expect(admittedBySql('', 'personal:private:%')).toEqual(admittedBySql('', undefined));
  });

  it('keeps the own arm inside its parentheses, so a preceding AND still binds it', () => {
    const own = stored.find((r) => r.scope === OWN_A)!.id;
    const found = admittedBySql('m.', OWN_A, `AND m.id != '${own}' `);
    expect(found).not.toContain(own);
    expect(found).toEqual(admittedBySql('m.', undefined));
  });

  it("admits the owner's row only when its own scope is passed", () => {
    const own = stored.find((r) => r.scope === OWN_A)!.id;
    expect(admittedBySql('', OWN_A)).toContain(own);
    expect(admittedBySql('', undefined)).not.toContain(own);
    expect(admittedBySql('', 'personal:private:b')).not.toContain(own);
  });
});
