// Each typed-object kind's table and audit rows, once for both adapters: the table its ids follow, whether it keeps
// versions, and the op, target and keys of its open, create, supersede and close rows.
import type { AuditOp } from '../../base/records/audit-ops.js';
import type { IncidentFields, ObjectFields, ObjectKind, SavableKind } from '../../base/records/object-types.js';
import type { JsonObject } from '../../base/util/json.js';

const KINDS = {
  decision: { table: 'decisions', idKey: 'decision_id' },
  incident: { table: 'incidents', idKey: 'incident_id' },
  process: { table: 'processes', idKey: 'process_id' },
  policy: { table: 'policies', idKey: 'policy_id' },
  skill: { table: 'skills', idKey: 'skill_id' },
  project_brief: { table: 'project_briefs', idKey: 'brief_id' },
  customer_note: { table: 'customer_notes', idKey: 'note_id' },
} as const satisfies Record<ObjectKind, { readonly table: string; readonly idKey: string }>;

/** The kind's table, whose AUTOINCREMENT sequence its ids follow. */
export const objectTable = (kind: ObjectKind): string => KINDS[kind].table;

interface SaveRule<K extends SavableKind> {
  /** A successor takes its predecessor's version plus one and the caller's change note; a decision has no version. */
  readonly versioned: boolean;
  /** The create row's keys after the id, in stored order: ids, counts and flags, never the object's text. */
  readonly createKeys: (fields: ObjectFields[K], version: number) => JsonObject;
  /** Keys the supersede row stores after its own. */
  readonly supersedeKeys?: (fields: ObjectFields[K]) => JsonObject;
}

const hasText = (text: string | null | undefined): boolean => text !== undefined && text !== null && text !== '';

// Tells an auto-refresh from a manual write in the audit log without a fourth audit op.
const refreshKeys = (f: ObjectFields['project_brief']): JsonObject =>
  f.receiptCount === undefined ? { refreshed: false } : { refreshed: true, receipt_count: f.receiptCount };

type SaveRules = { readonly [K in SavableKind]: SaveRule<K> };

const SAVE_RULES: SaveRules = {
  decision: { versioned: false, createKeys: (f) => ({ has_context: hasText(f.context) }) },
  process: {
    versioned: true,
    createKeys: (f, version) => ({ version, step_count: f.steps.length, has_description: hasText(f.description) }),
  },
  policy: { versioned: true, createKeys: (f, version) => ({ version, open_ended: f.validTo === null }) },
  skill: { versioned: true, createKeys: (f, version) => ({ version, has_trigger: f.trigger !== null }) },
  project_brief: {
    versioned: true,
    createKeys: (f, version) => ({ repo: f.repo, version, ...refreshKeys(f) }),
    supersedeKeys: refreshKeys,
  },
  customer_note: { versioned: true, createKeys: (f, version) => ({ customer: f.customer, version }) },
};

export const isVersioned = (kind: SavableKind): boolean => SAVE_RULES[kind].versioned;

/** One audit row's op, target and metadata; the adapter adds the tenant and actor. */
export interface ObjectAudit {
  readonly op: AuditOp;
  readonly targetId: string;
  readonly metadata: JsonObject;
}

export function createAudit<K extends SavableKind>(
  kind: K,
  id: number,
  fields: ObjectFields[K],
  version: number,
): ObjectAudit {
  const metadata = { [KINDS[kind].idKey]: id, ...SAVE_RULES[kind].createKeys(fields, version) };
  return { op: `${kind}_create`, targetId: String(id), metadata };
}

/** The row for `replaced` giving way to `id`, which holds `version`. */
export function supersedeAudit<K extends SavableKind>(
  kind: K,
  replaced: number,
  id: number,
  version: number,
  fields: ObjectFields[K],
): ObjectAudit {
  const rule = SAVE_RULES[kind];
  const own: JsonObject = { [KINDS[kind].idKey]: replaced, superseded_by: id };
  if (rule.versioned) own.new_version = version;
  return { op: `${kind}_supersede`, targetId: String(replaced), metadata: { ...own, ...rule.supersedeKeys?.(fields) } };
}

export function closeAudit(kind: ObjectKind, id: number): ObjectAudit {
  return { op: `${kind}_close`, targetId: String(id), metadata: { [KINDS[kind].idKey]: id } };
}

export function incidentOpenAudit(id: number, fields: IncidentFields): ObjectAudit {
  const metadata = {
    incident_id: id,
    has_context: hasText(fields.context),
    linked_memory_count: fields.linkedMemoryIds.length,
  };
  return { op: 'incident_open', targetId: String(id), metadata };
}
