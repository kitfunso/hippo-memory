// Store rules every typed object shares, one table row per kind; a rule only one kind has stays in its <kind>-store test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { Layer } from '../../src/core/memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { CustomerNote, Decision, Policy, Process, ProjectBrief, Skill } from '../../src/core/object-types.js';
import {
  saveCustomerNote,
  closeCustomerNote,
  loadCustomerNoteById,
  loadCustomerNotes,
  VALID_NOTE_STATES,
} from '../../src/objects/customer-notes.js';
import { saveSkill, closeSkill, loadSkillById, loadSkills, VALID_SKILL_STATES } from '../../src/objects/skills.js';
import {
  savePolicy,
  closePolicy,
  loadPolicyById,
  loadPolicies,
  VALID_POLICY_STATES,
} from '../../src/objects/policies.js';
import {
  saveProjectBrief,
  closeProjectBrief,
  loadProjectBriefById,
  loadProjectBriefs,
  VALID_BRIEF_STATES,
} from '../../src/objects/project-briefs.js';
import {
  saveProcess,
  closeProcess,
  loadProcessById,
  loadProcesses,
  VALID_PROCESS_STATES,
} from '../../src/objects/processes.js';
import {
  saveDecision,
  closeDecision,
  loadDecisionById,
  loadDecisions,
  VALID_DECISION_STATES,
} from '../../src/objects/decisions.js';
import { openIncident, loadIncidentById, loadIncidents, VALID_INCIDENT_STATES } from '../../src/objects/incidents.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { writeEntryThenFail } from '../_helpers/failing-write.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/core/config.js';
import { deleteEntry, writeEntry } from '../_helpers/root-forms.js';

let home: string;
beforeEach(() => {
  home = makeRoot('typed-object-store');
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function countRows(table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: `SELECT COUNT(*) as c` always returns exactly one row shaped { c: number }.
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally {
    closeHippoDb(db);
  }
}

function auditRows(op: string, targetId: number): Array<{ metadata_json: string }> {
  const db = openHippoDb(home);
  try {
    // SAFETY: the SELECT projects exactly one TEXT column, metadata_json.
    return db
      .prepare(`SELECT metadata_json FROM audit_log WHERE op = ? AND target_id = ?`)
      .all(op, String(targetId)) as Array<{ metadata_json: string }>;
  } finally {
    closeHippoDb(db);
  }
}

function mirrorOf(source: string, tenantId: string) {
  return createMemory(`${tenantId} ${source}`, {
    tags: [source],
    layer: Layer.Semantic,
    confidence: 'verified',
    source,
    tenantId,
  });
}

describe.each([
  [
    'customer_notes',
    'customer_note',
    `INSERT INTO customer_notes(memory_id, tenant_id, customer, note, version, status, created_at) VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`,
  ],
  [
    'skills',
    'skill',
    `INSERT INTO skills(memory_id, tenant_id, skill_name, instructions, version, status, created_at) VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`,
  ],
  [
    'policies',
    'policy',
    `INSERT INTO policies(memory_id, tenant_id, policy_name, policy_text, valid_from, version, status, created_at) VALUES (?, 'tenant-b', 'x', 'y', '2026-01-01T00:00:00.000Z', 1, 'active', ?)`,
  ],
  [
    'project_briefs',
    'project_brief',
    `INSERT INTO project_briefs(memory_id, tenant_id, repo, summary, version, status, created_at) VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`,
  ],
  [
    'processes',
    'process',
    `INSERT INTO processes(memory_id, tenant_id, process_name, steps, version, status, created_at) VALUES (?, 'tenant-b', 'x', '[]', 1, 'active', ?)`,
  ],
  [
    'incidents',
    'incident',
    `INSERT INTO incidents(memory_id, tenant_id, incident_text, status, created_at) VALUES (?, 'tenant-b', 'x', 'open', ?)`,
  ],
  [
    'decisions',
    'decision',
    `INSERT INTO decisions(memory_id, tenant_id, decision_text, status, created_at) VALUES (?, 'tenant-b', 'x', 'active', ?)`,
  ],
  [
    'predictions',
    'prediction',
    `INSERT INTO predictions(memory_id, tenant_id, class_tag, claim_text, closure_state, created_at) VALUES (?, 'tenant-b', 'x', 'y', 'open', ?)`,
  ],
])('%s table', (table, source, crossTenantInsert) => {
  it('SAVEPOINT atomicity: a mirror write that throws rolls back the memory and adds no row', () => {
    const m0 = countRows('memories');
    const t0 = countRows(table);
    expect(() => writeEntryThenFail(home, mirrorOf(source, 'default'))).toThrow('forced');
    expect(countRows('memories')).toBe(m0);
    expect(countRows(table)).toBe(t0);
  });

  it('INSERT trigger aborts a row whose tenant differs from its memory', () => {
    const mem = mirrorOf(source, 'tenant-a');
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(crossTenantInsert).run(mem.id, new Date().toISOString())).toThrow(
        /tenant_id must match memories\.tenant_id/,
      );
    } finally {
      closeHippoDb(db);
    }
  });
});

/** A typed row reduced to what the shared lifecycle owns; `body` is the kind's own text field. */
interface View {
  readonly id: number;
  readonly memoryId: string | null;
  readonly status: string;
  readonly supersededBy: number | null;
  readonly supersededAt: string | null;
  readonly closedAt: string | null;
  readonly version: number | null;
  readonly changeSummary: string | null;
  readonly body: string;
}

type Superseding = CustomerNote | Skill | Policy | ProjectBrief | Process | Decision;

function view(row: Superseding, body: string): View {
  return {
    id: row.id,
    memoryId: row.memoryId,
    status: row.status,
    supersededBy: row.supersededBy,
    supersededAt: row.supersededAt,
    closedAt: row.closedAt,
    version: 'version' in row ? row.version : null,
    changeSummary: 'changeSummary' in row ? row.changeSummary : null,
    body,
  };
}

interface Revision {
  readonly supersedes?: number;
  readonly changeSummary?: string;
}

interface Lineage {
  /** Audit op prefix and the noun in the supersede trigger's message. */
  readonly kind: string;
  readonly table: string;
  readonly versioned: boolean;
  save(tenant: string, body: string, rev?: Revision): Promise<View>;
  close(id: number): Promise<View>;
  byId(id: number): Promise<View | null>;
  activeIds(): Promise<number[]>;
}

const note = (n: CustomerNote): View => view(n, n.note);
const skill = (s: Skill): View => view(s, s.instructions);
const policy = (p: Policy): View => view(p, p.policyText);
const brief = (b: ProjectBrief): View => view(b, b.summary);
const proc = (p: Process): View => view(p, p.steps.join(' '));
const decision = (d: Decision): View => view(d, d.decisionText);
const ids = (rows: ReadonlyArray<{ id: number }>): number[] => rows.map((r) => r.id);

const LINEAGES: readonly Lineage[] = [
  {
    kind: 'customer_note',
    table: 'customer_notes',
    versioned: true,
    save: async (tenant, body, rev = {}) =>
      note(
        await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          customer: 'c',
          note: body,
          changeSummary: rev.changeSummary,
          supersedesNoteId: rev.supersedes,
        }),
      ),
    close: async (id) => note(await closeCustomerNote(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadCustomerNoteById(objectsAt(home), 'default', id);
      return r && note(r);
    },
    activeIds: async () =>
      ids(await loadCustomerNotes(objectsAt(home), 'default', { customer: 'c', status: 'active' })),
  },
  {
    kind: 'skill',
    table: 'skills',
    versioned: true,
    save: async (tenant, body, rev = {}) =>
      skill(
        await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          skillName: 'P',
          instructions: body,
          changeSummary: rev.changeSummary,
          supersedesSkillId: rev.supersedes,
        }),
      ),
    close: async (id) => skill(await closeSkill(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadSkillById(objectsAt(home), 'default', id);
      return r && skill(r);
    },
    activeIds: async () => ids(await loadSkills(objectsAt(home), 'default', { status: 'active' })),
  },
  {
    kind: 'policy',
    table: 'policies',
    versioned: true,
    save: async (tenant, body, rev = {}) =>
      policy(
        await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          policyName: 'P',
          policyText: body,
          changeSummary: rev.changeSummary,
          supersedesPolicyId: rev.supersedes,
        }),
      ),
    close: async (id) => policy(await closePolicy(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadPolicyById(objectsAt(home), 'default', id);
      return r && policy(r);
    },
    activeIds: async () => ids(await loadPolicies(objectsAt(home), 'default', { status: 'active' })),
  },
  {
    kind: 'project_brief',
    table: 'project_briefs',
    versioned: true,
    save: async (tenant, body, rev = {}) =>
      brief(
        await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          repo: 'r',
          summary: body,
          changeSummary: rev.changeSummary,
          supersedesBriefId: rev.supersedes,
        }),
      ),
    close: async (id) => brief(await closeProjectBrief(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadProjectBriefById(objectsAt(home), 'default', id);
      return r && brief(r);
    },
    activeIds: async () => ids(await loadProjectBriefs(objectsAt(home), 'default', { status: 'active', repo: 'r' })),
  },
  {
    kind: 'process',
    table: 'processes',
    versioned: true,
    save: async (tenant, body, rev = {}) =>
      proc(
        await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          processName: 'P',
          steps: body.split(' '),
          changeSummary: rev.changeSummary,
          supersedesProcessId: rev.supersedes,
        }),
      ),
    close: async (id) => proc(await closeProcess(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadProcessById(objectsAt(home), 'default', id);
      return r && proc(r);
    },
    activeIds: async () => ids(await loadProcesses(objectsAt(home), 'default', { status: 'active' })),
  },
  {
    kind: 'decision',
    table: 'decisions',
    versioned: false,
    save: async (tenant, body, rev = {}) =>
      decision(
        await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, tenant, {
          decisionText: body,
          supersedesDecisionId: rev.supersedes,
        }),
      ),
    close: async (id) => decision(await closeDecision(objectsAt(home), 'default', id)),
    byId: async (id) => {
      const r = await loadDecisionById(objectsAt(home), 'default', id);
      return r && decision(r);
    },
    activeIds: async () => ids(await loadDecisions(objectsAt(home), 'default', { status: 'active' })),
  },
];

describe.each(LINEAGES)('$kind supersede and close', (k) => {
  const counts = (): number[] => [countRows(k.table), countRows('memories')];
  const reload = async (id: number): Promise<View> => {
    const r = await k.byId(id);
    expect(r).not.toBeNull();
    return r!;
  };

  it('supersede chain v1 -> v2 -> v3: predecessor flips, only the head is active, one supersede audit', async () => {
    const v1 = await k.save('default', 'alpha one');
    const v2 = await k.save('default', 'beta two', { supersedes: v1.id, changeSummary: 'revised' });
    const v3 = await k.save('default', 'gamma three', { supersedes: v2.id });
    if (k.versioned) {
      expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
      expect(v2.changeSummary).toBe('revised');
    }
    expect(v2.id).not.toBe(v1.id);
    expect(v2.status).toBe('active');
    expect(v2.supersededBy).toBeNull();
    expect(v2.body).toBe('beta two');
    const reV1 = await reload(v1.id);
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    expect(reV1.supersededBy).not.toBe(reV1.id);
    expect(reV1.supersededAt).not.toBeNull();
    expect(await k.activeIds()).toEqual([v3.id]);
    const rows = auditRows(`${k.kind}_supersede`, v1.id);
    expect(rows.length).toBe(1);
    // SAFETY: a supersede audit row's metadata is the flat object the shared lifecycle writes.
    const meta = JSON.parse(rows[0].metadata_json) as { superseded_by: number; new_version?: number };
    expect(meta.superseded_by).toBe(v2.id);
    if (k.versioned) expect(meta.new_version).toBe(2);
  });

  it('supersede CAS: an already-superseded or missing target throws and writes nothing', async () => {
    const v1 = await k.save('default', 'alpha one');
    await k.save('default', 'beta two', { supersedes: v1.id });
    const before = counts();
    await expect(k.save('default', 'gamma three', { supersedes: v1.id })).rejects.toThrow(/not active/);
    await expect(k.save('default', 'ghost', { supersedes: 99999 })).rejects.toThrow(/not found/);
    expect(counts()).toEqual(before);
  });

  it('self-supersede preflight: superseding id 1 on an empty store throws not found and writes nothing', async () => {
    const before = counts();
    await expect(k.save('default', 'self ref', { supersedes: 1 })).rejects.toThrow(/not found/);
    expect(counts()).toEqual(before);
  });

  it('close flips active -> closed with one close audit; missing, closed and superseded rows refuse', async () => {
    await expect(k.close(77777)).rejects.toThrow(/not found/);
    const c = await k.save('default', 'alpha one');
    const closed = await k.close(c.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(auditRows(`${k.kind}_close`, c.id).length).toBe(1);
    await expect(k.close(c.id)).rejects.toThrow(/not active/);
    const v1 = await k.save('default', 'beta two');
    await k.save('default', 'gamma three', { supersedes: v1.id });
    await expect(k.close(v1.id)).rejects.toThrow(/not active/);
  });

  it('supersede trigger aborts a successor from another tenant', async () => {
    const a = await k.save('tenant-a', 'alpha one');
    const b = await k.save('tenant-b', 'beta two');
    const db = openHippoDb(home);
    try {
      expect(() => db.prepare(`UPDATE ${k.table} SET superseded_by = ? WHERE id = ?`).run(b.id, a.id)).toThrow(
        new RegExp(`superseded_by must reference a ${k.kind} in the same tenant`),
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('ON DELETE SET NULL: forgetting the mirrors orphans both versions, which stay loadable and active-listed', async () => {
    const v1 = await k.save('default', 'alpha one');
    const v2 = await k.save('default', 'beta two', { supersedes: v1.id });
    deleteEntry(home, v1.memoryId!);
    deleteEntry(home, v2.memoryId!);
    const reV1 = await reload(v1.id);
    expect(reV1.memoryId).toBeNull();
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    const reV2 = await reload(v2.id);
    expect(reV2.memoryId).toBeNull();
    expect(reV2.status).toBe('active');
    expect(reV2.body).toBe('beta two');
    expect(await k.activeIds()).toContain(v2.id);
  });
});

/** Casts a deliberately bad status past the type so the store's run-time check is what rejects it. */
function unchecked<S extends string | undefined>(status: string): S {
  // SAFETY: only used to send an invalid status the store must refuse.
  return status as S;
}

interface Listing {
  readonly kind: string;
  readonly states: ReadonlySet<string>;
  readonly expected: readonly string[];
  save(tenant: string, body: string): Promise<number>;
  list(tenant: string, status?: string): Promise<number[]>;
  found(tenant: string, id: number): Promise<boolean>;
}

const LISTINGS: readonly Listing[] = [
  {
    kind: 'customer_note',
    states: VALID_NOTE_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, { customer: 'c', note: body }))
        .id,
    list: async (t, s) =>
      ids(await loadCustomerNotes(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadCustomerNoteById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'skill',
    states: VALID_SKILL_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (
        await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, {
          skillName: 'P',
          instructions: body,
        })
      ).id,
    list: async (t, s) => ids(await loadSkills(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadSkillById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'policy',
    states: VALID_POLICY_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (
        await savePolicy(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, {
          policyName: 'P',
          policyText: body,
        })
      ).id,
    list: async (t, s) => ids(await loadPolicies(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadPolicyById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'project_brief',
    states: VALID_BRIEF_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, { repo: 'r', summary: body }))
        .id,
    list: async (t, s) =>
      ids(await loadProjectBriefs(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadProjectBriefById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'process',
    states: VALID_PROCESS_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (await saveProcess(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, { processName: 'P', steps: [body] }))
        .id,
    list: async (t, s) => ids(await loadProcesses(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadProcessById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'decision',
    states: VALID_DECISION_STATES,
    expected: ['active', 'superseded', 'closed'],
    save: async (t, body) =>
      (await saveDecision(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, { decisionText: body })).id,
    list: async (t, s) => ids(await loadDecisions(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadDecisionById(objectsAt(home), t, id)) !== null,
  },
  {
    kind: 'incident',
    states: VALID_INCIDENT_STATES,
    expected: ['open', 'resolved', 'closed'],
    save: async (t, body) =>
      (await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, t, { incidentText: body }, 'cli')).id,
    list: async (t, s) => ids(await loadIncidents(objectsAt(home), t, s === undefined ? {} : { status: unchecked(s) })),
    found: async (t, id) => (await loadIncidentById(objectsAt(home), t, id)) !== null,
  },
];

describe.each(LISTINGS)('$kind reads', (k) => {
  it('are tenant-scoped, and an unknown status filter is rejected', async () => {
    const a = await k.save('tenant-a', 'a-row');
    await k.save('tenant-b', 'b-row');
    expect(await k.list('tenant-a')).toEqual([a]);
    expect((await k.list('tenant-b')).length).toBe(1);
    expect(await k.list('tenant-c')).toEqual([]);
    expect(await k.found('tenant-b', a)).toBe(false);
    expect(await k.found('tenant-a', a)).toBe(true);
    await expect(k.list('default', 'retired')).rejects.toThrow(/status must be one of/);
    for (const s of k.expected) expect(k.states.has(s)).toBe(true);
  });
});
