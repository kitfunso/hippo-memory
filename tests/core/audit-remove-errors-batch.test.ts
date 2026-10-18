// auditRemoveErrors deletes on one handle after one read of the id set, with the same rows and forget reasons a delete per id wrote.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { AuditIssue } from '../../src/core/memory-audit.js';
import { computeSchemaFit, schemaFitFrom, schemaFitSourceOf } from '../../src/core/memory.js';
import { auditRemoveErrors } from '../../src/api/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const issue = (memoryId: string, severity: AuditIssue['severity'], reason: string): AuditIssue => ({
  memoryId,
  content: '',
  severity,
  reason,
});

describe('auditRemoveErrors', () => {
  it('deletes each unpinned error once, in issue order, with its own forget reason', async () => {
    const root = makeRoot('audit-batch');
    roots.push(root);
    const ctx: FullContext = apiCtx(root, 'default', { subject: 'audit-test', role: 'admin' });
    const first = createMemory('too short one');
    const second = createMemory('too short two');
    const pinned = { ...createMemory('pinned but flagged'), pinned: true };
    const warned = createMemory('only a warning here');
    for (const entry of [first, second, pinned, warned]) writeEntry(root, entry);

    const gone = await auditRemoveErrors(ctx, 'audit --fix', [
      issue(second.id, 'error', 'too short'),
      issue('no-such-id', 'error', 'missing'),
      issue(pinned.id, 'error', 'too short'),
      issue(first.id, 'error', 'vague'),
      issue(second.id, 'error', 'repeat'),
      issue(warned.id, 'warning', 'vague'),
    ]);

    expect(gone).toEqual([second.id, first.id]);
    expect(
      loadAllEntries(root, 'default')
        .map((e) => e.id)
        .sort(),
    ).toEqual([pinned.id, warned.id].sort());
    const db = openHippoDb(root);
    try {
      const forgets = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(forgets.map((e) => [e.targetId, e.actor, e.metadata]).sort()).toEqual(
        [
          [first.id, 'audit-test', { reason: 'audit --fix: vague' }],
          [second.id, 'audit-test', { reason: 'audit --fix: too short' }],
        ].sort(),
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('answers an empty list without opening the store', async () => {
    const ctx: FullContext = apiCtx('/no/such/root', 'default', { subject: 'audit-test', role: 'admin' });
    expect(await auditRemoveErrors(ctx, 'sleep-audit', [issue('x', 'warning', 'vague')])).toEqual([]);
  });
});

describe('schemaFitSourceOf', () => {
  it('scores as computeSchemaFit does over the same rows', () => {
    const rows = [
      createMemory('deploy pipeline failed on staging', { tags: ['error', 'deploy'] }),
      createMemory('cache refresh reported stale data', { tags: ['error', 'cache'] }),
      createMemory('equal weight beats optimisation', { tags: ['quant'] }),
    ];
    const source = schemaFitSourceOf(rows);
    for (const [content, tags] of [
      ['deploy failed again on staging', ['error']],
      ['new topic entirely', ['misc']],
    ] as const) {
      expect(schemaFitFrom(content, tags, source)).toBe(computeSchemaFit(content, [...tags], rows));
    }
  });
});
