// Admission sent as data admits the rows the callbacks contextGet and drillDown passed before 3.0 admitted, on a store
// that mixes tenants, scopes, origins, secrets, compaction items and digests, in process and from a store worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPACTION_MEMORY_TAG, DAG_LEVEL, type MemoryEntry } from '../../src/core/memory.js';
import { isWorthSurfacing } from '../../src/core/memory-quality.js';
import { classifyOriginProject, projectNames, type ProjectRef } from '../../src/core/project-identity.js';
import {
  ambientRefusal,
  descendantAdmits,
  type AmbientAdmission,
  type DescendantAdmission,
} from '../../src/core/read-admission.js';
import { passesScopeFilterForRecall } from '../../src/core/recall-scope.js';
import { isSessionDigestRow, SESSION_DIGEST_TAG } from '../../src/core/session-digest-row.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { loadAmbientCandidatesAt } from '../../src/store/candidates.js';
import type { AmbientRefusal, HippoStore, StoreGroups, SummaryDescendants } from '../../src/store/port.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../../src/store/rows.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { detectSecret } from '../../src/util/secret-detect.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seeded } from '../_helpers/recall-golden-seed.js';
import { writeEntry } from '../_helpers/root-forms.js';

const ACME = 'acme';
const GLOBEX = 'globex';
const SCOPES = [
  null,
  'team:eng',
  'personal:private:alice',
  'personal:private:bob',
  'slack:private:C1',
  'unknown:legacy',
];
const ORIGINS = ['proj', 'other', '', null];
const PROJECT: ProjectRef = { name: 'proj', legacyName: 'proj-folder', aliases: ['proj-alias'] };

let minute = 0;
function row(tenantId: string, id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  minute += 1;
  const created = new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString();
  return seeded(content, id, created, { tenant_id: tenantId, origin_project: 'proj', ...extra });
}

/** Every scope crossed with every origin, then each edge the old callbacks tested one by one. */
function ambientRows(tenantId: string, p: string): MemoryEntry[] {
  const rows = SCOPES.flatMap((scope, s) =>
    ORIGINS.map((origin, o) =>
      row(tenantId, `${p}_s${s}_o${o}`, `rollout note ${s} ${o} about the queue workers`, {
        scope,
        origin_project: origin,
      }),
    ),
  );
  return [
    ...rows,
    ...SCOPES.map((scope, s) =>
      row(tenantId, `${p}_pin_s${s}`, `pinned rule ${s} about the billing deploy window`, { scope, pinned: true }),
    ),
    row(tenantId, `${p}_pin_junk`, 'okay', { pinned: true }),
    row(tenantId, `${p}_junk`, 'wip'),
    row(tenantId, `${p}_junk_other`, 'done', { origin_project: 'other' }),
    row(tenantId, `${p}_old`, 'rollout target was the old staging cluster', { superseded_by: `${p}_s0_o0` }),
    ...ORIGINS.map((origin, o) =>
      row(tenantId, `${p}_secret_o${o}`, `vault path ${o} lives in the ops runbook`, {
        origin_project: origin,
        tags: ['secret'],
      }),
    ),
    row(tenantId, `${p}_alias_secret`, 'alias vault path lives in the ops runbook', {
      origin_project: 'proj-alias',
      tags: ['password'],
    }),
    row(tenantId, `${p}_compact_own`, 'compaction item about the deploy queue order', {
      source_session_id: 'sess-own',
      tags: [COMPACTION_MEMORY_TAG],
    }),
    row(tenantId, `${p}_compact_else`, 'compaction item from another session on the queue', {
      source_session_id: 'sess-else',
      tags: [COMPACTION_MEMORY_TAG],
    }),
    row(tenantId, `${p}_digest`, 'session digest: moved the queue workers to the new pool', {
      source: SESSION_DIGEST_TAG,
      source_session_id: 'sess-handoff',
      tags: [SESSION_DIGEST_TAG],
    }),
    row(tenantId, `${p}_digest_fact`, 'fact from the digest about the new worker pool', {
      source: SESSION_DIGEST_TAG,
      source_session_id: 'sess-handoff',
      tags: [SESSION_DIGEST_TAG],
      extracted_from: `${p}_digest`,
    }),
    row(tenantId, `${p}_digest_else`, 'session digest of another session on the pool', {
      source: SESSION_DIGEST_TAG,
      source_session_id: 'sess-else',
      tags: [SESSION_DIGEST_TAG],
    }),
  ];
}

const under = (parent: string, level: number, extra: Partial<MemoryEntry> = {}): Partial<MemoryEntry> => ({
  dag_parent_id: parent,
  dag_level: level,
  ...extra,
});

/** Summary trees whose children carry every scope and origin, a refused child with rows under it, and a leaf summary. */
function dagRows(tenantId: string, p: string): MemoryEntry[] {
  return [
    row(tenantId, `${p}_profile`, 'profile over the rollout summaries', { dag_level: 3 }),
    row(tenantId, `${p}_sum`, 'summary of the rollout week', under(`${p}_profile`, 2)),
    row(
      tenantId,
      `${p}_sum_private`,
      'private summary of the escalation',
      under(`${p}_profile`, 2, { scope: 'slack:private:C1' }),
    ),
    ...SCOPES.flatMap((scope, s) =>
      ORIGINS.map((origin, o) =>
        row(
          tenantId,
          `${p}_fact_s${s}_o${o}`,
          `fact ${s} ${o} under the rollout summary`,
          under(`${p}_sum`, 1, { scope, origin_project: origin }),
        ),
      ),
    ),
    ...SCOPES.map((scope, s) =>
      row(tenantId, `${p}_leaf_s${s}`, `leaf under the private fact ${s}`, under(`${p}_fact_s4_o0`, 0, { scope })),
    ),
    row(tenantId, `${p}_leaf_cross`, 'leaf under the other project fact', under(`${p}_fact_s0_o1`, 0)),
    row(tenantId, `${p}_leaf_open`, 'leaf under the open fact', under(`${p}_fact_s0_o0`, 0)),
    row(tenantId, `${p}_under_private_sum`, 'fact under the private summary', under(`${p}_sum_private`, 1)),
  ];
}

/** contextGet's pinned-only admit and quality floor before 3.0, as api/context.ts composed them. */
function oldLoaderAdmit(a: AmbientAdmission, refused: AmbientRefusal[]): (e: MemoryEntry) => boolean {
  const secretAdmit = (e: MemoryEntry): boolean => {
    if (!detectSecret(e).flagged) return true;
    const origin = e.origin_project;
    if (origin === undefined || origin === null || origin === '') return false;
    return projectNames(a.currentProject).includes(origin);
  };
  const ambientAdmit = (e: MemoryEntry): boolean => {
    if (a.handoffSessionId !== undefined && e.source_session_id === a.handoffSessionId && isSessionDigestRow(e)) {
      return false;
    }
    if (!secretAdmit(e)) return false;
    if (!passesScopeFilterForRecall(e.scope ?? null, a.exactScope, a.ownScope)) return false;
    if (a.includeCrossProject) return true;
    return classifyOriginProject(e.origin_project, a.currentProject) !== 'cross-project';
  };
  const ownSessionId = a.ownSessionId || '';
  const isOwnCompactionItem = (e: MemoryEntry): boolean =>
    ownSessionId !== '' && e.source_session_id === ownSessionId && e.tags.includes(COMPACTION_MEMORY_TAG);
  const admit = (e: MemoryEntry): boolean => !e.superseded_by && !isOwnCompactionItem(e) && ambientAdmit(e);
  return (e) => {
    if (!admit(e)) {
      refused.push({ id: e.id, reason: 'admission' });
      return false;
    }
    if (e.pinned || isWorthSurfacing(e)) return true;
    refused.push({ id: e.id, reason: 'quality' });
    return false;
  };
}

/** drillDown's admit before 3.0. */
function oldDrillAdmit(a: DescendantAdmission, summaryId: string): (row: MemoryEntry) => boolean {
  const readable = (row: MemoryEntry): boolean =>
    passesScopeFilterForRecall(row.scope ?? null, undefined, a.ownScope) &&
    (!a.project || classifyOriginProject(row.origin_project, a.project) !== 'cross-project');
  return (row) => readable(row) && (row.id !== summaryId || (row.dag_level ?? 0) >= DAG_LEVEL.topic);
}

const AMBIENT: readonly AmbientAdmission[] = [
  { currentProject: 'proj', includeCrossProject: false },
  { currentProject: 'proj', includeCrossProject: true },
  { currentProject: PROJECT, includeCrossProject: false, ownScope: 'personal:private:alice' },
  { currentProject: PROJECT, includeCrossProject: false, exactScope: 'team:eng' },
  {
    currentProject: PROJECT,
    includeCrossProject: true,
    exactScope: 'slack:private:C1',
    ownScope: 'personal:private:bob',
  },
  { currentProject: '', includeCrossProject: false },
  { currentProject: 'proj', includeCrossProject: false, ownSessionId: 'sess-own', handoffSessionId: 'sess-handoff' },
  { currentProject: 'other', includeCrossProject: false, ownSessionId: 'sess-else', handoffSessionId: 'sess-else' },
];

const DESCENDANT: readonly DescendantAdmission[] = [
  {},
  { ownScope: 'personal:private:alice' },
  { project: 'proj' },
  { project: PROJECT, ownScope: 'personal:private:bob' },
  { project: 'other' },
  { project: '' },
];

let root = '';
let rows: MemoryEntry[] = [];
let inProcess: HippoStore & StoreGroups;
let onWorkers: HippoStore & StoreGroups;

function onDb<T>(run: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return run(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The walk summaryWithDescendants documents, with the old callback as its admit. */
function oldWalk(tenantId: string, id: string, depth: number, admit: (row: MemoryEntry) => boolean): string[][] | null {
  const mine = rows.filter((r) => r.tenant_id === tenantId);
  const summary = mine.find((r) => r.id === id);
  if (!summary) return null;
  const levels: string[][] = [];
  const seen = new Set([id]);
  let parents = admit(summary) ? [id] : [];
  while (levels.length < depth && parents.length > 0) {
    const level = parents.flatMap((parent) =>
      mine
        .filter((r) => r.dag_parent_id === parent && !seen.has(r.id) && admit(r))
        .sort((x, y) => x.created.localeCompare(y.created) || x.id.localeCompare(y.id)),
    );
    if (level.length === 0) break;
    for (const r of level) seen.add(r.id);
    levels.push(level.map((r) => r.id));
    parents = level.map((r) => r.id);
  }
  return levels;
}

const levelIds = (walked: SummaryDescendants | null): string[][] | null =>
  walked && walked.levels.map((l) => l.map((r) => r.id));

beforeAll(() => {
  root = makeRoot('read-admission');
  for (const r of [
    ...ambientRows(ACME, 'a'),
    ...ambientRows(GLOBEX, 'b'),
    ...dagRows(ACME, 'a'),
    ...dagRows(GLOBEX, 'b'),
  ]) {
    writeEntry(root, r);
  }
  // SAFETY: the SELECT names exactly MemoryRow's columns.
  rows = onDb((db) =>
    (db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`).all() as MemoryRow[]).map(rowToEntry),
  );
  inProcess = sqliteStore(root);
  onWorkers = workerSqliteStore(root);
});

afterAll(async () => {
  await onWorkers?.close();
  await inProcess?.close();
});

describe('ambient admission as data', () => {
  it('refuses each row of both tenants for the reason the old admit did, under every case', () => {
    const reasons = new Set<string | null>();
    for (const admission of AMBIENT) {
      for (const e of rows) {
        const old: AmbientRefusal[] = [];
        oldLoaderAdmit(admission, old)(e);
        const now = ambientRefusal(e, admission);
        expect([e.id, now]).toEqual([e.id, old[0]?.reason ?? null]);
        reasons.add(now);
      }
    }
    expect(reasons).toEqual(new Set([null, 'admission', 'quality']));
  });

  it.each(AMBIENT.map((a, i) => [i, a] as const))(
    'case %i loads the rows and refusals the old callback loaded, in process and on a worker',
    async (_, admission) => {
      for (const tenantId of [ACME, GLOBEX]) {
        for (const recentNeeded of [0, 3, 200]) {
          // The old callback records its own refusals, in the order the loader asks it.
          const refused: AmbientRefusal[] = [];
          const oldAdmit = oldLoaderAdmit(admission, refused);
          const old = onDb((db) =>
            loadAmbientCandidatesAt(db, tenantId, recentNeeded, (e) => (oldAdmit(e) ? null : 'admission')),
          );
          const want = { entries: old.entries.map((e) => e.id), refused };
          for (const store of [inProcess, onWorkers]) {
            const got = await store.contextReads.ambientCandidates(tenantId, { recentNeeded, admit: admission });
            expect({ entries: got.entries.map((e) => e.id), refused: got.refused }).toEqual(want);
          }
        }
      }
    },
  );
});

describe('descendant admission as data', () => {
  it.each(DESCENDANT.map((a, i) => [i, a] as const))(
    'case %i admits each row the old readable admitted',
    (_, admission) => {
      const verdicts = rows.map((r) => [r.id, descendantAdmits(r, admission)]);
      expect(verdicts).toEqual(rows.map((r) => [r.id, oldDrillAdmit(admission, '')(r)]));
      expect(verdicts.filter(([, ok]) => !ok)).not.toEqual([]);
    },
  );

  it.each(DESCENDANT.map((a, i) => [i, a] as const))(
    'case %i walks the levels the old callback walked, paged or not, in process and on a worker',
    async (_, admission) => {
      for (const [tenantId, p] of [
        [ACME, 'a'],
        [GLOBEX, 'b'],
      ] as const) {
        for (const id of [`${p}_profile`, `${p}_sum`, `${p}_sum_private`, `${p}_fact_s4_o0`, 'missing']) {
          for (const depth of [1, 2, 3]) {
            const want = oldWalk(tenantId, id, depth, oldDrillAdmit(admission, id));
            for (const store of [inProcess, onWorkers]) {
              const walk = { depth, admit: admission, minSummaryLevel: DAG_LEVEL.topic };
              expect(levelIds(await store.dagReads.summaryWithDescendants(tenantId, id, walk))).toEqual(want);
              const paged = await store.dagReads.summaryWithDescendants(tenantId, id, {
                ...walk,
                page: { rows: 1_000 },
              });
              expect(levelIds(paged)).toEqual(want);
              expect(paged?.sizes ?? null).toEqual(want && want.map((level) => level.length));
            }
          }
        }
      }
    },
  );
});
