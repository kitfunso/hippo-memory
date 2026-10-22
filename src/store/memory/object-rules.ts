// How each typed-object kind's save becomes a held row, and the one column a list of the kind filters by.
import type { ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../../base/records/object-types.js';

/** What the store decides for a new row; the kind's own fields come from the save. */
export interface NewRow {
  readonly id: number;
  readonly memoryId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly changeSummary: string | null;
  readonly createdAt: string;
}

type RowOf<K extends SavableKind> = (fields: ObjectFields[K], row: NewRow) => ObjectByKind[K];

const head = (r: NewRow) => ({ id: r.id, memoryId: r.memoryId, tenantId: r.tenantId });
const tail = (r: NewRow) => ({
  version: r.version,
  status: 'active' as const,
  supersededBy: null,
  supersededAt: null,
  changeSummary: r.changeSummary,
  closedAt: null,
  createdAt: r.createdAt,
});

type RowsOf = { readonly [K in SavableKind]: RowOf<K> };

const ROW_OF: RowsOf = {
  decision: (f, r) => ({
    ...head(r),
    decisionText: f.decisionText,
    context: f.context ?? null,
    status: 'active',
    supersededBy: null,
    supersededAt: null,
    closedAt: null,
    createdAt: r.createdAt,
  }),
  process: (f, r) => ({
    ...head(r),
    processName: f.processName,
    description: f.description ?? null,
    steps: [...f.steps],
    ...tail(r),
  }),
  policy: (f, r) => ({
    ...head(r),
    policyName: f.policyName,
    policyText: f.policyText,
    validFrom: f.validFrom,
    validTo: f.validTo,
    ...tail(r),
  }),
  skill: (f, r) => ({ ...head(r), skillName: f.name, instructions: f.instructions, trigger: f.trigger, ...tail(r) }),
  project_brief: (f, r) => ({ ...head(r), repo: f.repo, summary: f.summary, ...tail(r) }),
  customer_note: (f, r) => ({ ...head(r), customer: f.customer, note: f.note, ...tail(r) }),
};

export function rowOf<K extends SavableKind>(kind: K): RowOf<K> {
  return ROW_OF[kind];
}

type FilterValues = { readonly [K in ObjectKind]?: (row: ObjectByKind[K]) => string };

const FILTER_VALUE: FilterValues = {
  project_brief: (row) => row.repo,
  customer_note: (row) => row.customer,
};

/** The kind's one filter column, for the kinds that have one. */
export function filterValue<K extends ObjectKind>(kind: K): ((row: ObjectByKind[K]) => string) | undefined {
  return FILTER_VALUE[kind];
}
