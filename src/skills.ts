/**
 * E2 skill first-class object (docs/plans/2026-05-30-e2-skill-object.md).
 *
 * A `skill` is a reusable, agent-followable capability: an `instructions` body
 * plus an optional `trigger` ("when to apply"), evolving via the supersede delta
 * lifecycle. "Executable" is scoped to an agent-followable INSTRUCTION that, once
 * exported into the agent's in-force rules (AGENTS.md / CLAUDE.md) via
 * `exportSkills`, is executed by the agent reading it. Literal code/command
 * execution is deferred (security; a future sandbox). The distinguishing
 * capability is therefore the EXPORT renderer, not a runtime.
 *
 * Reuses the process/decision supersede machinery verbatim (superseded_by self-FK
 * + CAS + INSERT-preflight + server-derived version + change_summary + supersede
 * tenant-match trigger). It DROPS process's `steps` (a skill's content is a single
 * `instructions` body) and ADDS `trigger` (stored in the `trigger_text` column -
 * `trigger` is a SQLite reserved keyword).
 *
 * The `skills` table is the source of truth (survives memory decay); the memory
 * mirror is for recall. memory_id is NULLABLE with ON DELETE SET NULL.
 *
 * Lifecycle: active -> superseded (a newer version replaces it) or active ->
 * closed (retired). Export renders ACTIVE skills only.
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { createMemory, Layer, SKILL_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type SkillStatus = 'active' | 'superseded' | 'closed';

export const VALID_SKILL_STATES: ReadonlySet<SkillStatus> = new Set<SkillStatus>([
  'active',
  'superseded',
  'closed',
]);

/** Field caps (untrusted at the HTTP/SDK boundary). instructions is a body, so a
 *  larger cap than the 4096 short-field convention. */
export const MAX_SKILL_NAME_LEN = 256;
export const MAX_SKILL_INSTRUCTIONS_LEN = 8192;
export const MAX_SKILL_TRIGGER_LEN = 1024;
/** Aggregate bound on a single export render (plan-eng-critic: cap the unbounded
 *  export body). Realistic active-skill counts are tens; 1000 is a generous bound. */
export const MAX_EXPORT_SKILLS = 1000;

export interface Skill {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion proceed without breaking
   *  the skill row. */
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

export interface SaveSkillOpts {
  skillName: string;
  instructions: string;
  /** Optional "when to apply" trigger. */
  trigger?: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE skill this new version supersedes. */
  supersedesSkillId?: number;
  /** Extra memory tags merged after ['skill']. */
  extraTags?: string[];
}

export interface ListSkillsOpts {
  status?: SkillStatus;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate + normalise skill fields. skill_name is trimmed and MUST be a single
 * line (no newlines) so it cannot break the H2 header in the export render
 * (plan-eng-critic). instructions are kept verbatim (operator content) but capped.
 * Returns the normalised name + trigger (null when absent/empty).
 */
function validateSkillFields(
  skillName: string,
  instructions: string,
  trigger: string | undefined,
): { name: string; trigger: string | null } {
  const name = (skillName ?? '').trim();
  if (name.length === 0) throw new Error('saveSkill: skillName is required');
  if (/[\r\n]/.test(name)) throw new Error('saveSkill: skillName must be a single line (no newlines)');
  if (name.length > MAX_SKILL_NAME_LEN) {
    throw new Error(`saveSkill: skillName exceeds the ${MAX_SKILL_NAME_LEN}-char cap`);
  }
  if (!instructions || instructions.trim().length === 0) {
    throw new Error('saveSkill: instructions are required');
  }
  if (instructions.length > MAX_SKILL_INSTRUCTIONS_LEN) {
    throw new Error(`saveSkill: instructions exceed the ${MAX_SKILL_INSTRUCTIONS_LEN}-char cap`);
  }
  let triggerVal: string | null = null;
  if (trigger !== undefined && trigger !== null && trigger.trim().length > 0) {
    if (trigger.length > MAX_SKILL_TRIGGER_LEN) {
      throw new Error(`saveSkill: trigger exceeds the ${MAX_SKILL_TRIGGER_LEN}-char cap`);
    }
    // Single-line, like skill_name: a trigger is a short "when to apply" phrase,
    // and a newline would let it forge a heading inside the export **When:** line
    // (independent-review 2026-05-30). Reject rather than emit a multi-line trigger.
    if (/[\r\n]/.test(trigger)) {
      throw new Error('saveSkill: trigger must be a single line (no newlines)');
    }
    triggerVal = trigger;
  }
  return { name, trigger: triggerVal };
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface SkillRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  skill_name: string;
  instructions: string;
  trigger_text: string | null;
  version: number;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    skillName: row.skill_name,
    instructions: row.instructions,
    trigger: row.trigger_text,
    version: row.version,
    status: row.status as SkillStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    changeSummary: row.change_summary,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const SKILL_COLS = `
  id, memory_id, tenant_id, skill_name, instructions, trigger_text, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`;

/** Recall-surface content for the memory mirror: name + optional trigger +
 *  instructions. Named (mirrors buildProcessContent) so the recall surface is
 *  deterministic + unit-testable. */
function buildSkillContent(skillName: string, instructions: string, trigger: string | null): string {
  let content = skillName;
  if (trigger) content += `\n\nWhen: ${trigger}`;
  content += `\n\n${instructions}`;
  return content;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a skill (or a new version that supersedes an existing one). Writes the
 * memory mirror + the skills row atomically inside writeEntry's SAVEPOINT. When
 * supersedesSkillId is given, the referenced ACTIVE row is preflighted (status +
 * version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same SAVEPOINT;
 * the new version = predecessor.version + 1 (server-derived).
 */
export function saveSkill(
  hippoRoot: string,
  tenantId: string,
  opts: SaveSkillOpts,
  actor: string = 'cli',
): Skill {
  assertTenantId('saveSkill', tenantId);
  const { name, trigger } = validateSkillFields(opts.skillName, opts.instructions, opts.trigger);
  const isSupersede = opts.supersedesSkillId !== undefined;
  const changeSummary = isSupersede ? (opts.changeSummary ?? null) : null;

  const now = new Date().toISOString();
  const content = buildSkillContent(name, opts.instructions, trigger);
  const tags = ['skill', ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'skill',
    tenantId,
  });
  mem.half_life_days = SKILL_HALF_LIFE_DAYS;

  let savedRow: SkillRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Preflight the supersede target BEFORE inserting the new row (so the new
      // autoincrement id can never be its own supersede target); read the
      // predecessor version in the same SELECT for server-derived versioning.
      // Mirrors saveProcess / savePolicy (codex P1 2026-05-28).
      let version = 1;
      if (opts.supersedesSkillId !== undefined) {
        const pred = db.prepare(
          `SELECT status, version FROM skills WHERE id = ? AND tenant_id = ?`,
        ).get(opts.supersedesSkillId, tenantId) as
          | { status: string; version: number }
          | undefined;
        if (!pred) {
          throw new Error(
            `saveSkill: skill ${opts.supersedesSkillId} to supersede not found for tenant ${tenantId}`,
          );
        }
        if (pred.status !== 'active') {
          throw new Error(
            `saveSkill: skill ${opts.supersedesSkillId} is not active (status='${pred.status}'); only active skills can be superseded.`,
          );
        }
        version = pred.version + 1;
      }

      const result = db.prepare(`
        INSERT INTO skills(
          memory_id, tenant_id, skill_name, instructions, trigger_text, version,
          status, superseded_by, superseded_at, change_summary, closed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL, ?)
      `).run(
        memoryId,
        tenantId,
        name,
        opts.instructions,
        trigger,
        version,
        changeSummary,
        now,
      );
      const skillId = Number(result.lastInsertRowid ?? 0);

      if (opts.supersedesSkillId !== undefined) {
        const sup = db.prepare(`
          UPDATE skills
          SET status = 'superseded', superseded_by = ?, superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
        `).run(skillId, now, opts.supersedesSkillId, tenantId, skillId);
        if (sup.changes === 0) {
          throw new Error(
            `saveSkill: skill ${opts.supersedesSkillId} could not be superseded (no longer active or self-reference).`,
          );
        }
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'skill_supersede',
          targetId: String(opts.supersedesSkillId),
          metadata: {
            skill_id: opts.supersedesSkillId,
            superseded_by: skillId,
            new_version: version,
          },
        });
      }

      const row = db.prepare(`SELECT ${SKILL_COLS} FROM skills WHERE id = ?`)
        .get(skillId) as SkillRow | undefined;
      if (!row) throw new Error('saveSkill: failed to reload saved skill row');
      savedRow = row;

      // GDPR-light metadata: ids + flags only, no skill text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'skill_create',
        targetId: String(skillId),
        metadata: {
          skill_id: skillId,
          version,
          has_trigger: trigger !== null,
        },
      });
    },
  });

  if (!savedRow) {
    throw new Error('saveSkill: afterWrite did not populate the row');
  }
  return rowToSkill(savedRow);
}

/**
 * Close (retire) an active skill. CAS guard WHERE status='active'; 0 changes
 * distinguishes not-found from not-active. A superseded row is terminal.
 */
export function closeSkill(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Skill {
  assertTenantId('closeSkill', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE skills
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'active'
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM skills WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeSkill: skill ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeSkill: skill ${id} is not active (status='${existing.status}'); only active skills can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${SKILL_COLS} FROM skills WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as SkillRow | undefined;
      if (!row) throw new Error(`closeSkill: skill ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'skill_close',
        targetId: String(id),
        metadata: { skill_id: id },
      });

      db.exec('COMMIT');
      return rowToSkill(row);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function loadSkillById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Skill | null {
  assertTenantId('loadSkillById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${SKILL_COLS} FROM skills WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadSkills(
  hippoRoot: string,
  tenantId: string,
  opts: ListSkillsOpts = {},
): Skill[] {
  assertTenantId('loadSkills', tenantId);
  const limit = opts.limit ?? 100;
  const db = openHippoDb(hippoRoot);
  try {
    let rows: SkillRow[];
    if (opts.status) {
      if (!VALID_SKILL_STATES.has(opts.status)) {
        throw new Error(
          `loadSkills: status must be one of ${Array.from(VALID_SKILL_STATES).join('|')}; got ${opts.status}`,
        );
      }
      rows = db.prepare(`
        SELECT ${SKILL_COLS} FROM skills
        WHERE tenant_id = ? AND status = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, opts.status, limit) as SkillRow[];
    } else {
      rows = db.prepare(`
        SELECT ${SKILL_COLS} FROM skills
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, limit) as SkillRow[];
    }
    return rows.map(rowToSkill);
  } finally {
    closeHippoDb(db);
  }
}

export function loadActiveSkills(
  hippoRoot: string,
  tenantId: string,
  opts: { limit?: number } = {},
): Skill[] {
  return loadSkills(hippoRoot, tenantId, { status: 'active', limit: opts.limit });
}

/**
 * Render the tenant's ACTIVE skills into ONE AGENTS.md / CLAUDE.md-style markdown
 * block (one H2 per skill, ordered by skill_name ASC for determinism), and RETURN
 * the string. Does NOT write any file. Returns '' when there are no active skills.
 *
 * skill_name is single-line (validated on save) so it cannot break the H2 header;
 * instructions are emitted verbatim (operator content). Bounded by MAX_EXPORT_SKILLS
 * active rows; each field is capped on save, so the rendered string is bounded.
 */
export function exportSkills(hippoRoot: string, tenantId: string): string {
  assertTenantId('exportSkills', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT ${SKILL_COLS} FROM skills
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY skill_name ASC, id ASC
      LIMIT ?
    `).all(tenantId, MAX_EXPORT_SKILLS) as SkillRow[];
    return rows
      .map(rowToSkill)
      .map((s) => {
        let block = `## ${s.skillName}`;
        if (s.trigger) block += `\n\n**When:** ${s.trigger}`;
        block += `\n\n${s.instructions}`;
        return block;
      })
      .join('\n\n');
  } finally {
    closeHippoDb(db);
  }
}
