// hippo.db's rows for the typed objects: each kind's table, columns, row mapping and, for a kind the shared save writes, its insert values and audit keys.
// A status column carries a CHECK constraint, so a row declares it as the kind's status union.
import type { AuditOp } from '../audit.js';
import { isJsonString } from '../../util/json.js';
import { warnDamagedColumn } from '../../util/stored-json.js';
import type { JsonObject } from '../working-memory.js';
import type { SourceObjectType } from '../graph-rows.js';
import type {
  BriefStatus, CustomerNote, Decision, DecisionStatus, Incident, IncidentStatus, NoteStatus, ObjectByKind, ObjectFields, ObjectKind,
  Policy, PolicyStatus, Process, ProcessStatus, ProjectBrief, SavableKind, Skill, SkillStatus,
} from '../object-types.js';

interface HeadRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
}

interface VersionedRow<S> extends HeadRow {
  version: number;
  status: S;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

interface DecisionRow extends HeadRow {
  decision_text: string;
  context: string | null;
  status: DecisionStatus;
  superseded_by: number | null;
  superseded_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface IncidentRow extends HeadRow {
  incident_text: string;
  context: string | null;
  status: IncidentStatus;
  resolution_text: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  linked_memory_ids: string;
  created_at: string;
}

interface ProcessRow extends VersionedRow<ProcessStatus> {
  process_name: string;
  description: string | null;
  steps: string;
}

interface PolicyRow extends VersionedRow<PolicyStatus> {
  policy_name: string;
  policy_text: string;
  valid_from: string;
  valid_to: string | null;
}

interface SkillRow extends VersionedRow<SkillStatus> {
  skill_name: string;
  instructions: string;
  trigger_text: string | null;
}

interface ProjectBriefRow extends VersionedRow<BriefStatus> {
  repo: string;
  summary: string;
}

interface CustomerNoteRow extends VersionedRow<NoteStatus> {
  customer: string;
  note: string;
}

export interface RowByKind {
  decision: DecisionRow;
  incident: IncidentRow;
  process: ProcessRow;
  policy: PolicyRow;
  skill: SkillRow;
  project_brief: ProjectBriefRow;
  customer_note: CustomerNoteRow;
}

// A reply lists an object's keys in the order its mapper sets them: head, the kind's own fields, tail.
const head = (row: HeadRow) => ({ id: row.id, memoryId: row.memory_id, tenantId: row.tenant_id });

const versionedTail = <S>(row: VersionedRow<S>) => ({
  version: row.version,
  status: row.status,
  supersededBy: row.superseded_by,
  supersededAt: row.superseded_at,
  changeSummary: row.change_summary,
  closedAt: row.closed_at,
  createdAt: row.created_at,
});

function rowToDecision(row: DecisionRow): Decision {
  return {
    ...head(row),
    decisionText: row.decision_text,
    context: row.context,
    status: row.status,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function parseLinkedMemoryIds(raw: string, id: number): string[] {
  try {
    // SAFETY: JSON.parse output is arbitrary; narrowed by Array.isArray plus
    // the per-element string check below before use as string[].
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
    return [];
  } catch {
    // A malformed list column reads as empty instead of failing the incident read.
    warnDamagedColumn({ table: 'incidents', id, column: 'linked_memory_ids' }, 'not valid JSON');
    return [];
  }
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    ...head(row),
    incidentText: row.incident_text,
    context: row.context,
    status: row.status,
    resolutionText: row.resolution_text,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    linkedMemoryIds: parseLinkedMemoryIds(row.linked_memory_ids, row.id),
    createdAt: row.created_at,
  };
}

/** A malformed stored steps value warns and reads back as no steps. */
function parseSteps(raw: string, id: number): string[] {
  const site = { table: 'processes', id, column: 'steps' };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isJsonString)) {
      return parsed;
    }
    warnDamagedColumn(site, 'wrong shape');
    return [];
  } catch {
    // Unreadable steps read back as none instead of failing the process read.
    warnDamagedColumn(site, 'not valid JSON');
    return [];
  }
}

const rowToProcess = (row: ProcessRow): Process => (
  { ...head(row), processName: row.process_name, description: row.description, steps: parseSteps(row.steps, row.id), ...versionedTail(row) }
);

const rowToPolicy = (row: PolicyRow): Policy => (
  { ...head(row), policyName: row.policy_name, policyText: row.policy_text, validFrom: row.valid_from, validTo: row.valid_to, ...versionedTail(row) }
);

const rowToSkill = (row: SkillRow): Skill => (
  { ...head(row), skillName: row.skill_name, instructions: row.instructions, trigger: row.trigger_text, ...versionedTail(row) }
);

const rowToProjectBrief = (row: ProjectBriefRow): ProjectBrief => ({ ...head(row), repo: row.repo, summary: row.summary, ...versionedTail(row) });

const rowToCustomerNote = (row: CustomerNoteRow): CustomerNote => ({ ...head(row), customer: row.customer, note: row.note, ...versionedTail(row) });

interface RowSpec<K extends ObjectKind> {
  readonly table: string;
  /** The column list every read selects: exactly the columns the kind's row declares. */
  readonly cols: string;
  readonly rowTo: (row: RowByKind[K]) => ObjectByKind[K];
  /** The audit metadata key that carries the object id. */
  readonly idKey: string;
  readonly closeOp: AuditOp;
  /** The one column a list may filter by equality. */
  readonly filterColumn?: string;
  /** Set for the kinds the graph extracts, so a save marks the graph stale and a close drops the object's graph rows. */
  readonly graphType?: SourceObjectType;
}

/** What one column of a new row can hold. */
export type ColumnValue = string | number | null;

interface InsertSpec<K extends SavableKind> {
  readonly createOp: AuditOp;
  readonly supersedeOp: AuditOp;
  /** A versioned table has `version` and `change_summary`: a successor takes its predecessor's version plus one and the caller's change note. */
  readonly versioned: boolean;
  /** The kind's own columns, in the order `values` fills them. */
  readonly columns: readonly string[];
  readonly values: (w: ObjectFields[K]) => readonly ColumnValue[];
  /** The create audit's keys after the id, in the order they are stored: ids, counts and flags, never the object's text. */
  readonly createMeta: (w: ObjectFields[K], version: number) => JsonObject;
  /** Keys the supersede audit stores after its own. */
  readonly supersedeMeta?: (w: ObjectFields[K]) => JsonObject;
}

/** Tells an auto-refresh from a manual write in the audit log without a fourth audit op. */
function refreshMeta(w: ObjectFields['project_brief']): JsonObject {
  return w.receiptCount === undefined ? { refreshed: false } : { refreshed: true, receipt_count: w.receiptCount };
}

type RowSpecs = { readonly [K in ObjectKind]: RowSpec<K> };
type InsertSpecs = { readonly [K in SavableKind]: { readonly insert: InsertSpec<K> } };

// An incident has no insert entry: it is opened and resolved by its own writes.
const OBJECT_ROWS: RowSpecs & InsertSpecs = {
  decision: {
    table: 'decisions',
    cols: `
  id, memory_id, tenant_id, decision_text, context, status,
  superseded_by, superseded_at, closed_at, created_at
`,
    rowTo: rowToDecision,
    idKey: 'decision_id',
    closeOp: 'decision_close',
    graphType: 'decision',
    insert: {
      createOp: 'decision_create',
      supersedeOp: 'decision_supersede',
      versioned: false,
      columns: ['decision_text', 'context'],
      values: (w) => [w.decisionText, w.context ?? null],
      createMeta: (w) => ({ has_context: w.context !== undefined && w.context !== null && w.context !== '' }),
    },
  },
  incident: {
    table: 'incidents',
    cols: `
  id, memory_id, tenant_id, incident_text, context, status,
  resolution_text, resolved_at, closed_at, linked_memory_ids, created_at
`,
    rowTo: rowToIncident,
    idKey: 'incident_id',
    closeOp: 'incident_close',
  },
  process: {
    table: 'processes',
    cols: `
  id, memory_id, tenant_id, process_name, description, steps, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`,
    rowTo: rowToProcess,
    idKey: 'process_id',
    closeOp: 'process_close',
    insert: {
      createOp: 'process_create',
      supersedeOp: 'process_supersede',
      versioned: true,
      columns: ['process_name', 'description', 'steps'],
      values: (w) => [w.processName, w.description ?? null, JSON.stringify(w.steps)],
      createMeta: (w, version) => ({
        version,
        step_count: w.steps.length,
        has_description: w.description !== undefined && w.description !== null && w.description !== '',
      }),
    },
  },
  policy: {
    table: 'policies',
    cols: `
  id, memory_id, tenant_id, policy_name, policy_text, valid_from, valid_to,
  version, status, superseded_by, superseded_at, change_summary, closed_at, created_at
`,
    rowTo: rowToPolicy,
    idKey: 'policy_id',
    closeOp: 'policy_close',
    graphType: 'policy',
    insert: {
      createOp: 'policy_create',
      supersedeOp: 'policy_supersede',
      versioned: true,
      columns: ['policy_name', 'policy_text', 'valid_from', 'valid_to'],
      values: (w) => [w.policyName, w.policyText, w.validFrom, w.validTo],
      createMeta: (w, version) => ({ version, open_ended: w.validTo === null }),
    },
  },
  skill: {
    table: 'skills',
    cols: `
  id, memory_id, tenant_id, skill_name, instructions, trigger_text, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`,
    rowTo: rowToSkill,
    idKey: 'skill_id',
    closeOp: 'skill_close',
    insert: {
      createOp: 'skill_create',
      supersedeOp: 'skill_supersede',
      versioned: true,
      columns: ['skill_name', 'instructions', 'trigger_text'],
      values: (w) => [w.name, w.instructions, w.trigger],
      createMeta: (w, version) => ({ version, has_trigger: w.trigger !== null }),
    },
  },
  project_brief: {
    table: 'project_briefs',
    cols: `
  id, memory_id, tenant_id, repo, summary, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`,
    rowTo: rowToProjectBrief,
    idKey: 'brief_id',
    closeOp: 'project_brief_close',
    filterColumn: 'repo',
    graphType: 'project',
    insert: {
      createOp: 'project_brief_create',
      supersedeOp: 'project_brief_supersede',
      versioned: true,
      columns: ['repo', 'summary'],
      values: (w) => [w.repo, w.summary],
      createMeta: (w, version) => ({ repo: w.repo, version, ...refreshMeta(w) }),
      supersedeMeta: refreshMeta,
    },
  },
  customer_note: {
    table: 'customer_notes',
    cols: `
  id, memory_id, tenant_id, customer, note, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`,
    rowTo: rowToCustomerNote,
    idKey: 'note_id',
    closeOp: 'customer_note_close',
    filterColumn: 'customer',
    graphType: 'customer',
    insert: {
      createOp: 'customer_note_create',
      supersedeOp: 'customer_note_supersede',
      versioned: true,
      columns: ['customer', 'note'],
      values: (w) => [w.customer, w.note],
      createMeta: (w, version) => ({ customer: w.customer, version }),
    },
  },
};

export function rowSpec<K extends ObjectKind>(kind: K): RowSpec<K> {
  const rows: RowSpecs = OBJECT_ROWS;
  return rows[kind];
}

export function insertSpec<K extends SavableKind>(kind: K): InsertSpec<K> {
  const rows: InsertSpecs = OBJECT_ROWS;
  return rows[kind].insert;
}
