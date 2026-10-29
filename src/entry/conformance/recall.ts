// The recall and audit checks: goals, continuity and the planning-fallacy read on an empty store,
// the audit appends and list, recall's finishing writes, the counters and the token ledger.
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { ACTOR, OTHER_TENANT, TENANT, rowOf, writeRows, type Check } from './kit.js';

const audit = (
  op: AppendAuditOptions['op'],
  targetId: string,
  tenantId = TENANT,
): AppendAuditOptions => ({
  tenantId,
  actor: ACTOR,
  op,
  targetId,
});

const emptyReads: Check = async (store, expect) => {
  const goals = await store.activeGoals({ tenantId: TENANT, sessionId: 's1' });
  expect([goals.goals, goals.policies.size]).toEqual([[], 0]);
  expect(await store.continuity(TENANT, 5, null)).toEqual({
    activeSnapshot: null,
    sessionHandoff: null,
    recentSessionEvents: [],
  });
  expect(await store.planningFallacyEvidence(TENANT, ['cutover'])).toEqual({
    classTag: null,
    tiebreak: false,
    baserate: null,
  });
};

export const RECALL_READ_CHECKS = {
  'answers no goals, no continuity and no prediction class on an empty store': emptyReads,
} satisfies Readonly<Record<string, Check>>;

const appendsAndLists: Check = async (store, expect) => {
  await store.appendAuditEvents([]);
  await store.appendAuditEvents([audit('remember', 'mem_a'), audit('remember', 'mem_b')]);
  await store.appendAuditEvents([audit('remember', 'mem_c', OTHER_TENANT)]);
  const listed = await store.auditLog.listAuditEvents({ tenantId: TENANT });
  expect(listed.map((row) => [row.op, row.targetId])).toEqual([
    ['remember', 'mem_b'],
    ['remember', 'mem_a'],
  ]);
  const limited = await store.auditLog.listAuditEvents({ tenantId: TENANT, limit: 1 });
  expect(limited.length >= 1 && limited[0]?.targetId === 'mem_b').toBe(true);
};

const finishesRecall: Check = async (store, expect) => {
  const row = rowOf(TENANT, 'recalled once', 1);
  await writeRows(store, [row]);
  await store.finishRecall({
    goalLog: [],
    audit: [audit('recall', row.id)],
    strengthen: { ids: [row.id], opts: { tenantId: TENANT, recallBoostAblated: false } },
  });
  const [after] = await store.entriesByIds([row.id], TENANT);
  expect(after?.retrievalCount).toBe(1);
  const ops = (await store.auditLog.listAuditEvents({ tenantId: TENANT, op: 'recall' })).map(
    (r) => r.targetId,
  );
  expect(ops).toEqual([row.id]);
};

const countsWithoutAudit: Check = async (store, expect) => {
  await store.bumpRecallStats(2);
  await store.recordTokens({
    tenantId: TENANT,
    surface: 'hook',
    event: 'inject',
    items: 1,
    tokens: 40,
  });
  expect(await store.auditLog.listAuditEvents({ tenantId: TENANT })).toEqual([]);
};

export const AUDIT_CHECKS = {
  "appends audit rows in order and lists a tenant's newest first": appendsAndLists,
  'finishes a recall with its audit rows and strengthens the rows it returned': finishesRecall,
  'counts recalls and books token rows without writing an audit row': countsWithoutAudit,
} satisfies Readonly<Record<string, Check>>;
