// The typed objects as every store hands them over, and what a save carries for each kind.
// `memoryId` is null once the mirror memory is forgotten or archived; the object row outlives it.

export type DecisionStatus = 'active' | 'superseded' | 'closed';

export interface Decision {
  id: number;
  memoryId: string | null;
  tenantId: string;
  decisionText: string;
  context: string | null;
  status: DecisionStatus;
  /** Successor decision id; set only when status === 'superseded'. */
  supersededBy: number | null;
  supersededAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type IncidentStatus = 'open' | 'resolved' | 'closed';

export interface Incident {
  id: number;
  memoryId: string | null;
  tenantId: string;
  incidentText: string;
  context: string | null;
  status: IncidentStatus;
  /** Set only when status === 'resolved'. */
  resolutionText: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Linked receipts: memory ids that are this incident's evidence. */
  linkedMemoryIds: string[];
  createdAt: string;
}

export type ProcessStatus = 'active' | 'superseded' | 'closed';

export interface Process {
  id: number;
  memoryId: string | null;
  tenantId: string;
  processName: string;
  description: string | null;
  /** Ordered step list (the process body). Stored as a JSON array of strings. */
  steps: string[];
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: ProcessStatus;
  /** Successor process id; set only when status === 'superseded'. */
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type PolicyStatus = 'active' | 'superseded' | 'closed';

export interface Policy {
  id: number;
  memoryId: string | null;
  tenantId: string;
  policyName: string;
  policyText: string;
  /** ISO-8601 datetime as `toISOString` gives it; when the policy takes effect. Always set. */
  validFrom: string;
  /** ISO-8601 datetime as `toISOString` gives it; when it expires. null = open-ended. */
  validTo: string | null;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: PolicyStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type SkillStatus = 'active' | 'superseded' | 'closed';

export interface Skill {
  id: number;
  memoryId: string | null;
  tenantId: string;
  skillName: string;
  instructions: string;
  /** Optional "when to apply"; stored in the trigger_text column. */
  trigger: string | null;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: SkillStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type BriefStatus = 'active' | 'superseded' | 'closed';

export interface ProjectBrief {
  id: number;
  memoryId: string | null;
  tenantId: string;
  /** The repo identifier this brief is scoped to (e.g. `hippo`). */
  repo: string;
  /** The brief body. */
  summary: string;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: BriefStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type NoteStatus = 'active' | 'superseded' | 'closed';

export interface CustomerNote {
  id: number;
  memoryId: string | null;
  tenantId: string;
  /** The account/customer entity this note is scoped to (free-form identifier). */
  customer: string;
  /** The note body. */
  note: string;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: NoteStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

/** Each kind is named by the `source` its mirror memory carries. */
export interface ObjectByKind {
  decision: Decision;
  incident: Incident;
  process: Process;
  policy: Policy;
  skill: Skill;
  project_brief: ProjectBrief;
  customer_note: CustomerNote;
}

export type ObjectKind = keyof ObjectByKind;

/** What one save stores, per kind the shared save writes; core has checked and resolved every value. */
export interface ObjectFields {
  decision: { readonly decisionText: string; readonly context: string | undefined };
  process: { readonly processName: string; readonly description: string | undefined; readonly steps: readonly string[] };
  policy: { readonly policyName: string; readonly policyText: string; readonly validFrom: string; readonly validTo: string | null };
  skill: { readonly name: string; readonly instructions: string; readonly trigger: string | null };
  /** `receiptCount` is set only when a refresh wrote this version. */
  project_brief: { readonly repo: string; readonly summary: string; readonly receiptCount: number | undefined };
  customer_note: { readonly customer: string; readonly note: string };
}

/** The kinds whose rows are active until a successor supersedes them; an incident is opened and resolved instead. */
export type SavableKind = keyof ObjectFields;

/** What opening an incident stores; core has checked the text, and the store checks each linked id. */
export interface IncidentFields {
  readonly incidentText: string;
  readonly context: string | undefined;
  /** The memories that are the incident's evidence, in the order the caller gave them. */
  readonly linkedMemoryIds: readonly string[];
}

/** One memory a brief refresh cites. */
export interface BriefReceipt {
  id: string;
  created: string;
  source: string;
  content: string;
}
