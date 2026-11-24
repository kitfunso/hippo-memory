export type DecisionStatus = 'active' | 'superseded' | 'closed';

export interface Decision {
  id: number;
  memoryId: string | null;
  tenantId: string;
  decisionText: string;
  context: string | null;
  status: DecisionStatus;
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
  resolutionText: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
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
  steps: string[];
  version: number;
  status: ProcessStatus;
  supersededBy: number | null;
  supersededAt: string | null;
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
  validFrom: string;
  validTo: string | null;
  version: number;
  status: PolicyStatus;
  supersededBy: number | null;
  supersededAt: string | null;
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
  trigger: string | null;
  version: number;
  status: SkillStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type BriefStatus = 'active' | 'superseded' | 'closed';

export interface ProjectBrief {
  id: number;
  memoryId: string | null;
  tenantId: string;
  repo: string;
  summary: string;
  version: number;
  status: BriefStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export type NoteStatus = 'active' | 'superseded' | 'closed';

export interface CustomerNote {
  id: number;
  memoryId: string | null;
  tenantId: string;
  customer: string;
  note: string;
  version: number;
  status: NoteStatus;
  supersededBy: number | null;
  supersededAt: string | null;
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

/** What one save stores, per kind the shared save writes; core has checked and resolved every
 * value. */
export interface ObjectFields {
  decision: { readonly decisionText: string; readonly context: string | undefined };
  process: {
    readonly processName: string;
    readonly description: string | undefined;
    readonly steps: readonly string[];
  };
  policy: {
    readonly policyName: string;
    readonly policyText: string;
    readonly validFrom: string;
    readonly validTo: string | null;
  };
  skill: { readonly name: string; readonly instructions: string; readonly trigger: string | null };
  project_brief: {
    readonly repo: string;
    readonly summary: string;
    readonly receiptCount: number | undefined;
  };
  customer_note: { readonly customer: string; readonly note: string };
}

/** Why a save or close wrote nothing: the tenant holds no such row (`missing`), the row's
 * `status` is not one the write may start from, another writer moved it between the check and
 * the write (`raced`), or the written row could not be read back (`vanished`). Core turns each
 * into its own error text. */
export type ObjectRefusal =
  | { readonly refused: 'missing' }
  | { readonly refused: 'status'; readonly status: string }
  | { readonly refused: 'raced' }
  | { readonly refused: 'vanished' };

/** Tells a refusal from the row a write answered; no row carries a `refused` key. */
export function isObjectRefusal<T extends object>(
  written: T | ObjectRefusal,
): written is ObjectRefusal {
  return 'refused' in written;
}

/** The kinds whose rows are active until a successor supersedes them; an incident is opened and
 * resolved instead. */
export type SavableKind = keyof ObjectFields;

/** What opening an incident stores; core has checked the text, and the store checks each linked
 * id. */
export interface IncidentFields {
  readonly incidentText: string;
  readonly context: string | undefined;
  readonly linkedMemoryIds: readonly string[];
}

/** One memory a brief refresh cites. */
export interface BriefReceipt {
  id: string;
  created: string;
  source: string;
  content: string;
}
