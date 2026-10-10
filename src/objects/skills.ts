/** Skill object: an agent-followable `instructions` body plus an optional `trigger`, evolving via supersession.
 *  `exportSkills` renders ACTIVE skills into AGENTS.md / CLAUDE.md rules; running code from a skill is deferred (security).
 *  `trigger` is stored in `trigger_text` because it is a SQLite reserved keyword. */

import { BadRequestError } from '../core/api-errors.js';
import { assertTenantId } from '../store/tenant.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { checkText, requireLine } from './fields.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { Skill, SkillStatus } from '../store/object-types.js';
import type { Objects } from '../store/port.js';
import { sqliteObjects } from '../store/sqlite/objects-group.js';

export type { Skill, SkillStatus } from '../store/object-types.js';

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

/** Recall-surface content for the memory mirror: name, optional trigger, instructions. */
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

/** Create a skill, or a new version superseding an existing one, in the `objects` store group's one transaction. */
export function saveSkill(
  hippoRoot: string,
  tenantId: string,
  opts: SaveSkillOpts,
  actor: string = 'cli',
): Skill {
  return saveObjectAt(SKILL, { hippoRoot, tenantId, actor }, opts);
}

/** Close (retire) an active skill; a superseded row is terminal. */
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

/** Render the tenant's ACTIVE skills into one AGENTS.md / CLAUDE.md-style markdown block (H2 per skill, ordered by skill_name) and return it; writes no file.
 *  Bounded by MAX_EXPORT_SKILLS rows; instructions are emitted verbatim. */
export function exportSkills(hippoRoot: string, tenantId: string): string {
  assertTenantId('exportSkills', tenantId);
  return skillsBlock(sqliteObjects(hippoRoot).activeSkillsByName(tenantId, MAX_EXPORT_SKILLS));
}

/** `exportSkills` over a served store's group. */
export async function skillsMarkdown(objects: Objects, tenantId: string): Promise<string> {
  assertTenantId('exportSkills', tenantId);
  return skillsBlock(await objects.activeSkillsByName(tenantId, MAX_EXPORT_SKILLS));
}

function skillsBlock(skills: readonly Skill[]): string {
  return skills
    .map((s) => {
      let block = `## ${s.skillName}`;
      if (s.trigger) block += `\n\n**When:** ${s.trigger}`;
      block += `\n\n${s.instructions}`;
      return block;
    })
    .join('\n\n');
}
