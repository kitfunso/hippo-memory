// One adapter per typed object, so a lifecycle test runs the same steps over all seven store modules.
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import type { SourceObjectType } from '../../src/graph/types.js';
import { closeDecision, loadDecisionById, loadDecisions, saveDecision } from '../../src/decisions.js';
import { closeIncident, loadIncidentById, loadIncidents, saveIncident } from '../../src/incidents.js';
import { closeProcess, loadProcessById, loadProcesses, saveProcess } from '../../src/processes.js';
import { closeSkill, loadSkillById, loadSkills, saveSkill } from '../../src/skills.js';
import { closeCustomerNote, loadCustomerNoteById, loadCustomerNotes, saveCustomerNote } from '../../src/customer-notes.js';
import { closePolicy, loadPolicies, loadPolicyById, savePolicy } from '../../src/policies.js';
import { closeProjectBrief, loadProjectBriefById, loadProjectBriefs, saveProjectBrief } from '../../src/project-briefs.js';

/** The fields every typed object shares; each module's own row type is assignable to it. */
export interface ObjectRow {
  readonly id: number;
  readonly memoryId: string | null;
  readonly status: string;
}

export interface SaveArgs {
  readonly label: string;
  readonly supersedes?: number;
  readonly actor?: string;
  /** The customer or repo the row belongs to; the five types with no such field ignore it. */
  readonly owner?: string;
  readonly extraTags?: string[];
  /** Flips the type's optional input: left out where the fixture sets it, set where the fixture leaves it out. */
  readonly alt?: boolean;
}

export interface ListArgs {
  readonly status?: string;
  readonly limit?: number;
  /** The customer or repo to narrow to; only the two types with that filter read it. */
  readonly owner?: string;
}

export interface TypedObjectSpec {
  readonly type: string;
  readonly table: string;
  /** The graph's name for this type, or null for a type the graph never indexes. */
  readonly graphSource: SourceObjectType | null;
  readonly canSupersede: boolean;
  /** The customer or repo the fixture rows carry, or null for a type whose list has no such filter. */
  readonly owner: string | null;
  save(root: string, tenantId: string, args: SaveArgs): ObjectRow;
  /** A save whose first required field is blank, so the store's own field check is what answers. */
  saveBlank(root: string, tenantId: string): ObjectRow;
  close(root: string, tenantId: string, id: number, actor?: string): ObjectRow;
  load(root: string, tenantId: string, id: number): ObjectRow | null;
  list(root: string, tenantId: string, args?: ListArgs): readonly ObjectRow[];
}

interface UncheckedListOpts<S extends string> {
  status?: S;
  limit?: number;
}

/** Hands a list function a status its type forbids, so the store's own runtime check is what answers. */
function unchecked<S extends string>(args: ListArgs | undefined): UncheckedListOpts<S> {
  // SAFETY: deliberately unchecked; the store's status validation is the behaviour under test.
  return { status: args?.status as S | undefined, limit: args?.limit };
}

const revised = (a: SaveArgs): string | undefined => (a.supersedes === undefined ? undefined : `revised (${a.label})`);

export const TYPED_OBJECT_SPECS: readonly TypedObjectSpec[] = [
  {
    type: 'decision',
    table: 'decisions',
    graphSource: 'decision',
    canSupersede: true,
    owner: null,
    save: (root, tenantId, a) => saveDecision(root, tenantId, {
      decisionText: `Use Postgres for billing (${a.label})`, context: a.alt ? undefined : 'cheaper to run',
      supersedesDecisionId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveDecision(root, tenantId, { decisionText: '' }),
    close: closeDecision,
    load: loadDecisionById,
    list: (root, tenantId, a) => loadDecisions(root, tenantId, unchecked(a)),
  },
  {
    type: 'incident',
    table: 'incidents',
    graphSource: null,
    canSupersede: false,
    owner: null,
    save: (root, tenantId, a) => saveIncident(root, tenantId, {
      incidentText: `Checkout returned 500s (${a.label})`, context: a.alt ? undefined : 'after the deploy', extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveIncident(root, tenantId, { incidentText: '' }),
    close: closeIncident,
    load: loadIncidentById,
    list: (root, tenantId, a) => loadIncidents(root, tenantId, unchecked(a)),
  },
  {
    type: 'process',
    table: 'processes',
    graphSource: null,
    canSupersede: true,
    owner: null,
    save: (root, tenantId, a) => saveProcess(root, tenantId, {
      processName: 'Release', steps: ['run the tests', `tag the build (${a.label})`], description: a.alt ? undefined : 'weekly cut',
      changeSummary: revised(a), supersedesProcessId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveProcess(root, tenantId, { processName: '', steps: ['a step'] }),
    close: closeProcess,
    load: loadProcessById,
    list: (root, tenantId, a) => loadProcesses(root, tenantId, unchecked(a)),
  },
  {
    type: 'skill',
    table: 'skills',
    graphSource: null,
    canSupersede: true,
    owner: null,
    save: (root, tenantId, a) => saveSkill(root, tenantId, {
      skillName: 'Review a migration', instructions: `Check the down path (${a.label})`, trigger: a.alt ? undefined : 'a schema change',
      changeSummary: revised(a), supersedesSkillId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveSkill(root, tenantId, { skillName: '', instructions: 'do it' }),
    close: closeSkill,
    load: loadSkillById,
    list: (root, tenantId, a) => loadSkills(root, tenantId, unchecked(a)),
  },
  {
    type: 'customer note',
    table: 'customer_notes',
    graphSource: 'customer',
    canSupersede: true,
    owner: 'Acme Ltd',
    save: (root, tenantId, a) => saveCustomerNote(root, tenantId, {
      customer: a.owner ?? 'Acme Ltd', note: `Prefers email (${a.label})`,
      changeSummary: revised(a), supersedesNoteId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveCustomerNote(root, tenantId, { customer: '', note: 'a note' }),
    close: closeCustomerNote,
    load: loadCustomerNoteById,
    list: (root, tenantId, a) => loadCustomerNotes(root, tenantId, { ...unchecked(a), customer: a?.owner }),
  },
  {
    type: 'policy',
    table: 'policies',
    graphSource: 'policy',
    canSupersede: true,
    owner: null,
    // A fixed validFrom keeps the row free of the clock, since it defaults to now.
    save: (root, tenantId, a) => savePolicy(root, tenantId, {
      policyName: 'Retention', policyText: `Delete logs after 90 days (${a.label})`, validFrom: '2026-01-01',
      validTo: a.alt ? '2027-01-01' : undefined,
      changeSummary: revised(a), supersedesPolicyId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => savePolicy(root, tenantId, { policyName: '', policyText: 'a rule' }),
    close: closePolicy,
    load: loadPolicyById,
    list: (root, tenantId, a) => loadPolicies(root, tenantId, unchecked(a)),
  },
  {
    type: 'project brief',
    table: 'project_briefs',
    graphSource: 'project',
    canSupersede: true,
    owner: 'acme/web',
    save: (root, tenantId, a) => saveProjectBrief(root, tenantId, {
      repo: a.owner ?? 'acme/web', summary: `Storefront app (${a.label})`, refreshReceiptCount: a.alt ? 3 : undefined,
      changeSummary: revised(a), supersedesBriefId: a.supersedes, extraTags: a.extraTags,
    }, a.actor),
    saveBlank: (root, tenantId) => saveProjectBrief(root, tenantId, { repo: '', summary: 'a summary' }),
    close: closeProjectBrief,
    load: loadProjectBriefById,
    list: (root, tenantId, a) => loadProjectBriefs(root, tenantId, { ...unchecked(a), repo: a?.owner }),
  },
];

/** Swaps the clock fields and the random memory ids for fixed marks; works on a row's JSON and on an HTTP body alike. */
export function maskVolatile(text: string): string {
  return text
    .replace(/"(createdAt|supersededAt|closedAt|resolvedAt)":"[^"]+"/g, '"$1":"<ts>"')
    .replace(/\b[a-z]{3}_[0-9a-f]{12}\b/g, '<mem>');
}

/** A row as the JSON a client would get, key order included. */
export function stableJson(row: ObjectRow | null): string {
  return maskVolatile(JSON.stringify(row));
}

/** The lines a characterization test pins: one per observation, in the order the steps ran. */
export class Transcript {
  private readonly lines: string[] = [];

  say(label: string, value: string | number | boolean): void {
    this.lines.push(`${label}: ${value}`);
  }

  each(label: string, values: readonly string[]): void {
    if (values.length === 0) this.lines.push(`${label}: (none)`);
    for (const value of values) this.lines.push(`${label}: ${value}`);
  }

  /** Records what the call returned, or the error class and its exact message. */
  tries(label: string, fn: () => string): void {
    try {
      this.lines.push(`${label}: ${fn()}`);
    } catch (e) {
      this.lines.push(`${label}: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
    }
  }

  /** For a call expected to be refused: records the error, or that the call went through. */
  fails(label: string, fn: () => void): void {
    this.tries(label, () => {
      fn();
      return 'did not throw';
    });
  }

  /** Masked as a whole, since an error message can quote a memory id too. */
  text(): string {
    return maskVolatile(this.lines.join('\n'));
  }
}

interface AuditRow {
  id: number;
  tenant_id: string;
  actor: string;
  op: string;
  target_id: string | null;
  metadata_json: string;
}

/** Reads audit rows in write order and hands back only those written since the last read. */
export class AuditTail {
  private lastId = 0;

  constructor(private readonly root: string) {}

  /** One line per new row: tenant, actor, op, target and the stored metadata string, so key order is pinned. */
  next(): string[] {
    const db = openHippoDb(this.root);
    try {
      // SAFETY: the SELECT names exactly the six audit_log columns AuditRow declares.
      const rows = db.prepare(
        `SELECT id, tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE id > ? ORDER BY id`,
      ).all(this.lastId) as AuditRow[];
      if (rows.length > 0) this.lastId = rows[rows.length - 1]!.id;
      return rows.map((r) => maskVolatile(`${r.tenant_id} ${r.actor} ${r.op} ${r.target_id ?? 'null'} ${r.metadata_json}`));
    } finally {
      closeHippoDb(db);
    }
  }
}

interface MirrorMemory {
  tenant_id: string;
  content: string;
  tags_json: string;
  kind: string;
  layer: string;
  source: string;
  confidence: string;
}

/** The mirror memory's pinned fields on one line; the content is JSON-quoted so its newlines stay visible. */
export function mirrorLine(root: string, memoryId: string | null): string {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names exactly the seven memories columns MirrorMemory declares.
    const m = db.prepare(
      `SELECT tenant_id, content, tags_json, kind, layer, source, confidence FROM memories WHERE id = ?`,
    ).get(memoryId) as MirrorMemory | undefined;
    if (!m) return '(no memory)';
    return `tenant=${m.tenant_id} kind=${m.kind} layer=${m.layer} source=${m.source} confidence=${m.confidence} tags=${m.tags_json} content=${JSON.stringify(m.content)}`;
  } finally {
    closeHippoDb(db);
  }
}

/** Row counts of the object table, the memories and the audit log, to show a failed write left nothing behind. */
export function rowCounts(root: string, table: string): string {
  const db = openHippoDb(root);
  try {
    const count = (name: string): number => {
      // SAFETY: COUNT(*) always yields one row with the single numeric column aliased n.
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
      return row.n;
    };
    return `objects=${count(table)} memories=${count('memories')} audit=${count('audit_log')}`;
  } finally {
    closeHippoDb(db);
  }
}

interface QueueRow {
  tenant_id: string;
  memory_id: string;
  kind: string;
  status: string;
}

interface EntityRow {
  tenant_id: string;
  source_object_type: string | null;
  source_object_id: number | null;
}

export interface GraphState {
  /** One line per graph_extraction_queue row, in insert order, with the memory id swapped for the object that owns it. */
  readonly queue: string[];
  /** One line per entity sourced from a typed object, in insert order. */
  readonly entities: string[];
}

export function readGraphState(root: string, ownerOf: ReadonlyMap<string, string>): GraphState {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names exactly the four graph_extraction_queue columns QueueRow declares.
    const queue = db.prepare(
      `SELECT tenant_id, memory_id, kind, status FROM graph_extraction_queue ORDER BY id`,
    ).all() as QueueRow[];
    // SAFETY: the SELECT names exactly the three entities columns EntityRow declares.
    const entities = db.prepare(
      `SELECT tenant_id, source_object_type, source_object_id FROM entities ORDER BY id`,
    ).all() as EntityRow[];
    return {
      queue: queue.map((q) => `${q.tenant_id} ${ownerOf.get(q.memory_id) ?? q.memory_id} ${q.kind} ${q.status}`),
      entities: entities.map((e) => `${e.tenant_id} ${e.source_object_type}#${e.source_object_id}`),
    };
  } finally {
    closeHippoDb(db);
  }
}
