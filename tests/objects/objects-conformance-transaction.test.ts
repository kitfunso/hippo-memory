// On hippo.db a write whose audit row fails keeps nothing.
import { describe, expect, it } from 'vitest';
import { cpSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { TENANT_A } from '../_helpers/store-conformance.js';
import { makeRoot } from '../_helpers/make-root.js';
import type { AuditOp } from '../../src/core/audit-ops.js';
import {
  T2,
  T3,
  ACTOR,
  CASES,
  fixture,
  saving,
  rowOf,
  createOp,
  closeOp,
  auditRowsAt,
  opening,
  mirrorIdOf,
  incidentOf,
  useObjectsConformance,
} from '../_helpers/objects-conformance.js';

useObjectsConformance();

describe("hippo.db's Objects writes are one transaction each", () => {
  /** A constraint the audit log really enforces, so the append fails after the rows of the same write are in. */
  function refuseAuditOps(root: string, ops: readonly AuditOp[]): void {
    const db = openHippoDb(root);
    try {
      const named = ops.map((op) => `'${op}'`).join(', ');
      db.exec(
        `CREATE TRIGGER audit_op_refused BEFORE INSERT ON audit_log WHEN NEW.op IN (${named}) BEGIN SELECT RAISE(ABORT, 'audit row refused'); END`,
      );
    } finally {
      closeHippoDb(db);
    }
  }

  it.each(CASES)(
    'a $kind save or close whose audit row is refused keeps no row, no mirror, no successor link, no closed status and no audit row',
    async (c) => {
      const root = makeRoot('objects-atomic', { init: false });
      cpSync(fixture.dir, root, { recursive: true });
      const store = sqliteStore(root);
      const { objects } = store;
      const first = saving(c, 1);
      await objects.saveObject(TENANT_A, c.kind, first.save);
      refuseAuditOps(root, [createOp(c.kind), closeOp(c.kind)]);
      const fresh = saving(c, 2, { at: T2 });
      const successor = saving(c, 3, { at: T2, supersedesId: 1 });
      const before = auditRowsAt(root);

      await expect(objects.saveObject(TENANT_A, c.kind, fresh.save)).rejects.toThrow('audit row refused');
      await expect(objects.saveObject(TENANT_A, c.kind, successor.save)).rejects.toThrow('audit row refused');
      await expect(
        objects.closeObject(TENANT_A, c.kind, 1, { from: ['active'], actor: ACTOR, at: T3 }),
      ).rejects.toThrow('audit row refused');

      expect(await objects.listObjects(TENANT_A, c.kind, { limit: 10 })).toEqual([rowOf(c, 1, first)]);
      expect(
        await store.entriesByIds([first.save.mirror.id, fresh.save.mirror.id, successor.save.mirror.id], TENANT_A),
      ).toMatchObject([{ id: first.save.mirror.id }]);
      expect(auditRowsAt(root)).toEqual(before);
      await store.close();
    },
  );

  it('an incident with more links than one lookup chunk is checked across chunks and names the first unheld link', async () => {
    const root = makeRoot('objects-links', { init: false });
    cpSync(fixture.dir, root, { recursive: true });
    const store = sqliteStore(root);
    const { objects } = store;
    const first = opening(1);
    await objects.openIncident(TENANT_A, first.open);
    const held = Array.from({ length: 1200 }, () => mirrorIdOf(first));
    const late = [...held.slice(0, 1100), 'mem_missing_late', 'mem_missing_later', ...held.slice(1100)];

    expect(await objects.openIncident(TENANT_A, opening(2, { at: T2, links: late }).open)).toEqual({
      refused: 'unlinked',
      memoryId: 'mem_missing_late',
    });
    expect(await objects.openIncident(TENANT_A, opening(3, { at: T2, links: held }).open)).toMatchObject({
      status: 'open',
    });
    await store.close();
  });

  it('an incident open or resolve whose audit row is refused keeps no row, no mirror, no resolved status and no audit row', async () => {
    const root = makeRoot('objects-atomic', { init: false });
    cpSync(fixture.dir, root, { recursive: true });
    const store = sqliteStore(root);
    const { objects } = store;
    const first = opening(1);
    await objects.openIncident(TENANT_A, first.open);
    refuseAuditOps(root, ['incident_open', 'incident_resolve']);
    const second = opening(2, { at: T2, links: [mirrorIdOf(first)] });
    const before = auditRowsAt(root);

    await expect(objects.openIncident(TENANT_A, second.open)).rejects.toThrow('audit row refused');
    await expect(objects.resolveIncident(TENANT_A, 1, { text: 'fixed', actor: ACTOR, at: T3 })).rejects.toThrow(
      'audit row refused',
    );

    expect(await objects.listObjects(TENANT_A, 'incident', { limit: 10 })).toEqual([incidentOf(1, first)]);
    expect(await store.entriesByIds([mirrorIdOf(first), mirrorIdOf(second)], TENANT_A)).toMatchObject([
      { id: mirrorIdOf(first) },
    ]);
    expect(auditRowsAt(root)).toEqual(before);
    await store.close();
  });
});
