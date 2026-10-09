/**
 * Skills as a first-class, versioned object.
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

import { BadRequestError } from './api-errors.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { assertTenantId } from './tenant.js';
import type { KeysetPosition } from './keyset.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { checkText, requireLine } from './objects/fields.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './objects/lifecycle.js';
import type { Skill, SkillStatus } from './store/object-types.js';
import { rowSpec, type RowByKind } from './store/sqlite/object-rows.js';

export type { Skill, SkillStatus } from './store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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
/** Aggregate bound on a single export render so the export body is never unbounded.
 *  Realistic active-skill counts are tens; 1000 is a generous bound. */
export const MAX_EXPORT_SKILLS = 1000;

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
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The trigger as stored, or null for none. One line, because a newline would forge a heading inside the exported **When:** line. */
function checkTrigger(trigger: string | undefined): string | null {
  if (trigger === undefined || trigger === null || trigger.trim().length === 0) return null;
  if (trigger.length > MAX_SKILL_TRIGGER_LEN) {
    throw new BadRequestError(`saveSkill: trigger exceeds the ${MAX_SKILL_TRIGGER_LEN}-char cap`);
  }
  if (/[\r\n]/.test(trigger)) {
    throw new BadRequestError('saveSkill: trigger must be a single line (no newlines)');
  }
  return trigger;
}

/** Recall-surface content for the memory mirror: name + optional trigger +
 *  instructions. Named (mirrors buildProcessContent) so the recall surface is
 *  deterministic + unit-testable. */
function buildSkillContent(skillName: string, instructions: string, trigger: string | null): string {
  let content = skillName;
  if (trigger) content += `\n\nWhen: ${trigger}`;
  content += `\n\n${instructions}`;
  return content;
}

export const SKILL: SavableDescriptor<'skill', SaveSkillOpts> = {
  kind: 'skill',
  label: 'skill',
  plural: 'skills',
  fn: { get: 'loadSkillById', close: 'closeSkill', list: 'loadSkills', save: 'saveSkill' },
  states: VALID_SKILL_STATES,
  closableFrom: ['active'],
  draft(opts) {
    // The name becomes an H2 header in the export, so it must be one line.
    const name = requireLine(opts.skillName, MAX_SKILL_NAME_LEN, {
      required: 'saveSkill: skillName is required',
      singleLine: 'saveSkill: skillName must be a single line (no newlines)',
      tooLong: `saveSkill: skillName exceeds the ${MAX_SKILL_NAME_LEN}-char cap`,
    });
    checkText(opts.instructions, MAX_SKILL_INSTRUCTIONS_LEN, {
      required: 'saveSkill: instructions are required',
      tooLong: `saveSkill: instructions exceed the ${MAX_SKILL_INSTRUCTIONS_LEN}-char cap`,
    });
    const trigger = checkTrigger(opts.trigger);
    return {
      fields: { name, instructions: opts.instructions, trigger },
      content: buildSkillContent(name, opts.instructions, trigger),
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesSkillId,
      changeSummary: opts.changeSummary,
      at: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a skill (or a new version that supersedes an existing one). Writes the
 * memory mirror + the skills row in the `objects` store group's one transaction. When
 * supersedesSkillId is given, the referenced ACTIVE row is preflighted (status +
 * version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same transaction;
 * the new version = predecessor.version + 1 (server-derived).
 */
export function saveSkill(
  hippoRoot: string,
  tenantId: string,
  opts: SaveSkillOpts,
  actor: string = 'cli',
): Skill {
  return saveObjectAt(SKILL, { hippoRoot, tenantId, actor }, opts);
}

/**
 * Close (retire) an active skill. A superseded row is terminal.
 */
export function closeSkill(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): Skill {
  return closeObjectAt(hippoRoot, SKILL, tenantId, id, actor);
}

export function loadSkillById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): Skill | null {
  return objectByIdAt(hippoRoot, SKILL, tenantId, id);
}

export function loadSkills(
  hippoRoot: string,
  tenantId: string,
  opts: ListSkillsOpts = {},
): Skill[] {
  return listObjectsAt(hippoRoot, SKILL, tenantId, opts);
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
    // SAFETY: the SELECT names the skill row's own column list.
    const rows = db.prepare(`
      SELECT ${rowSpec('skill').cols} FROM skills
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY skill_name ASC, id ASC
      LIMIT ?
    `).all(tenantId, MAX_EXPORT_SKILLS) as RowByKind['skill'][];
    return rows
      .map(rowSpec('skill').rowTo)
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
