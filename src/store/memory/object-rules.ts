// What each typed-object kind stores on a save and writes in its audit rows, as hippo.db's object tables do.
import type { AuditOp } from '../../base/records/audit-ops.js';
import type { ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../../base/records/object-types.js';
import type { AuditEvent } from '../port/types.js';

type Metadata = AuditEvent['metadata'];

export const ID_KEY = {
  decision: 'decision_id',
  incident: 'incident_id',
  process: 'process_id',
  policy: 'policy_id',
  skill: 'skill_id',
  project_brief: 'brief_id',
  customer_note: 'note_id',
} as const satisfies Record<ObjectKind, string>;

export const createOp = (kind: SavableKind): AuditOp => `${kind}_create`;
export const supersedeOp = (kind: SavableKind): AuditOp => `${kind}_supersede`;
export const closeOp = (kind: ObjectKind): AuditOp => `${kind}_close`;

/** What the store decides for a new row; the kind's own fields come from the save. */
export interface NewRow {
  readonly id: number;
  readonly memoryId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly changeSummary: string | null;
  readonly createdAt: string;
}

export interface SaveRules<K extends SavableKind> {
  readonly row: (fields: ObjectFields[K], row: NewRow) => ObjectByKind[K];
  /** The create row's keys after the id. */
  readonly createKeys: (fields: ObjectFields[K], version: number) => Metadata;
  /** Set for a versioned kind; a decision carries no version. */
  readonly versionOf?: (row: ObjectByKind[K]) => number;
  /** Keys the supersede row stores after its own. */
  readonly supersedeKeys?: (fields: ObjectFields[K]) => Metadata;
}

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
const versionOf = (row: { readonly version: number }): number => row.version;
const refreshKeys = (f: ObjectFields['project_brief']): Metadata =>
  f.receiptCount === undefined ? { refreshed: false } : { refreshed: true, receipt_count: f.receiptCount };

type SaveRulesByKind = { readonly [K in SavableKind]: SaveRules<K> };

const SAVE_RULES: SaveRulesByKind = {
  decision: {
    row: (f, r) => ({
      ...head(r),
      decisionText: f.decisionText,
      context: f.context ?? null,
      status: 'active',
      supersededBy: null,
      supersededAt: null,
      closedAt: null,
      createdAt: r.createdAt,
    }),
    createKeys: (f) => ({ has_context: Boolean(f.context) }),
  },
  process: {
    row: (f, r) => ({
      ...head(r),
      processName: f.processName,
      description: f.description ?? null,
      steps: [...f.steps],
      ...tail(r),
    }),
    createKeys: (f, version) => ({ version, step_count: f.steps.length, has_description: Boolean(f.description) }),
    versionOf,
  },
  policy: {
    row: (f, r) => ({
      ...head(r),
      policyName: f.policyName,
      policyText: f.policyText,
      validFrom: f.validFrom,
      validTo: f.validTo,
      ...tail(r),
    }),
    createKeys: (f, version) => ({ version, open_ended: f.validTo === null }),
    versionOf,
  },
  skill: {
    row: (f, r) => ({ ...head(r), skillName: f.name, instructions: f.instructions, trigger: f.trigger, ...tail(r) }),
    createKeys: (f, version) => ({ version, has_trigger: f.trigger !== null }),
    versionOf,
  },
  project_brief: {
    row: (f, r) => ({ ...head(r), repo: f.repo, summary: f.summary, ...tail(r) }),
    createKeys: (f, version) => ({ repo: f.repo, version, ...refreshKeys(f) }),
    versionOf,
    supersedeKeys: refreshKeys,
  },
  customer_note: {
    row: (f, r) => ({ ...head(r), customer: f.customer, note: f.note, ...tail(r) }),
    createKeys: (f, version) => ({ customer: f.customer, version }),
    versionOf,
  },
};

export function saveRules<K extends SavableKind>(kind: K): SaveRules<K> {
  return SAVE_RULES[kind];
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
