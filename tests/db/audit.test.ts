import { describe, it, expect, vi } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { appendAuditEvents, queryAuditEvents } from '../../src/store/sqlite/audit.js';
import type { AppendAuditOpts } from '../../src/store/port/types.js';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { recordAuditEventsRowByRow } from '../_helpers/root-forms.js';

describe('audit log', () => {
  it('appendAuditEvents persists one row with required fields', () => {
    const home = makeRoot('audit');
    const db = openHippoDb(home);
    try {
      appendAuditEvents(db, [
        {
          tenantId: 'default',
          actor: 'cli',
          op: 'remember',
          targetId: 'm1',
          metadata: { content_len: 42 },
        },
      ]);
      const rows = queryAuditEvents(db, { tenantId: 'default' });
      expect(rows.length).toBe(1);
      expect(rows[0]!.op).toBe('remember');
      expect(rows[0]!.targetId).toBe('m1');
      expect(rows[0]!.metadata.content_len).toBe(42);
      expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('queryAuditEvents filters by op and limit', () => {
    const home = makeRoot('audit');
    const db = openHippoDb(home);
    try {
      for (const op of ['remember', 'remember', 'recall', 'forget'] as const) {
        appendAuditEvents(db, [{ tenantId: 'default', actor: 'cli', op }]);
      }
      const recalls = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(recalls.length).toBe(1);
      const limited = queryAuditEvents(db, { tenantId: 'default', limit: 2 });
      expect(limited.length).toBe(2);
    } finally {
      closeHippoDb(db);
    }
  });

  it('queryAuditEvents isolates by tenant', () => {
    const home = makeRoot('audit');
    const db = openHippoDb(home);
    try {
      appendAuditEvents(db, [{ tenantId: 'alpha', actor: 'cli', op: 'remember' }]);
      appendAuditEvents(db, [{ tenantId: 'beta', actor: 'cli', op: 'remember' }]);
      expect(queryAuditEvents(db, { tenantId: 'alpha' }).length).toBe(1);
      expect(queryAuditEvents(db, { tenantId: 'beta' }).length).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('recordAuditEventsRowByRow returns the row that fails and still writes the rows after it', () => {
    const home = makeRoot('audit');
    const db = openHippoDb(home);
    try {
      db.exec(
        `CREATE TRIGGER refuse_m2 BEFORE INSERT ON audit_log WHEN NEW.target_id = 'm2' BEGIN SELECT RAISE(ABORT, 'audit row refused'); END`,
      );

      const failed = recordAuditEventsRowByRow(
        home,
        ['m1', 'm2', 'm3'].map((targetId) => ({
          tenantId: 'default',
          actor: 'sleep',
          op: 'mv_rescue' as const,
          targetId,
        })),
      );

      expect(failed.map((f) => [f.event.targetId, String(f.error)])).toEqual([['m2', 'Error: audit row refused']]);
      expect(
        queryAuditEvents(db, { tenantId: 'default' })
          .map((e) => e.targetId)
          .sort(),
      ).toEqual(['m1', 'm3']);
    } finally {
      closeHippoDb(db);
    }
  });

  it('appendAuditEvents writes in one statement the rows it writes one call per row', () => {
    const events: AppendAuditOpts[] = [
      { tenantId: 'default', actor: 'cli', op: 'remember', targetId: 'm1', metadata: { n: 1, s: '2', nested: [true] } },
      { tenantId: 'other', actor: 'api_key:hk_1', op: 'recall' },
      { tenantId: 'default', actor: 'cli', op: 'forget', metadata: {} },
    ];
    const rowsAfter = (write: (db: DatabaseSyncLike) => void) => {
      const db = openHippoDb(makeRoot('audit'));
      try {
        write(db);
        return db
          .prepare(
            'SELECT tenant_id, actor, op, target_id, typeof(target_id) AS t, metadata_json FROM audit_log ORDER BY id',
          )
          .all();
      } finally {
        closeHippoDb(db);
      }
    };
    let statements: string[] = [];
    const batched = rowsAfter((db) => {
      statements = recordStatements(() => appendAuditEvents(db, events)).statements;
    });
    expect(statements).toHaveLength(1);
    expect(batched).toEqual(
      rowsAfter((db) => {
        for (const event of events) appendAuditEvents(db, [event]);
      }),
    );
  });

  it('prepares each audit insert once per handle, however many calls', () => {
    const db = openHippoDb(makeRoot('audit'));
    const prepare = vi.spyOn(db, 'prepare');
    try {
      for (let i = 0; i < 3; i++) appendAuditEvents(db, [{ tenantId: 'default', actor: 'cli', op: 'remember' }]);
      const recall = { tenantId: 'default', actor: 'cli', op: 'recall' } as const;
      for (let i = 0; i < 2; i++) appendAuditEvents(db, [recall, recall]);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_log'))).toHaveLength(2);
      expect(queryAuditEvents(db, { tenantId: 'default' })).toHaveLength(7);
    } finally {
      prepare.mockRestore();
      closeHippoDb(db);
    }
  });
});
