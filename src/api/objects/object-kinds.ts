// What only one typed-object kind does: an incident's open and resolve, the policies in force at a date, the skills
// export, a brief built from its repo's receipts, and the memory a new decision replaces.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { Incident, Policy, ProjectBrief } from '../../base/records/object-types.js';
import { MAX_CUSTOMER_LEN, MAX_NOTE_LEN } from '../../domain/objects/customer-notes.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import { resolveActiveDecisionIdByMemory, weakenSupersededMemory } from '../../domain/objects/decisions.js';
import { openIncident, resolveOpenIncident, type SaveIncidentOptions } from '../../domain/objects/incidents.js';
import { policiesAsOf } from '../../domain/objects/policies.js';
import { MAX_PROCESS_STEP_LEN, MAX_PROCESS_STEPS } from '../../domain/objects/processes.js';
import {
  briefFromReceipts,
  MAX_BRIEF_SUMMARY_LEN,
  MAX_REPO_LEN,
  refreshedBrief,
  type BriefDigest,
} from '../../domain/objects/project-briefs.js';
import {
  MAX_SKILL_INSTRUCTIONS_LEN,
  MAX_SKILL_NAME_LEN,
  MAX_SKILL_TRIGGER_LEN,
  skillsMarkdown,
} from '../../domain/objects/skills.js';
import type { Context } from '../types.js';
import { objectsOf, saveSiteOf, taggedFrom, type WriteOrigin } from './objects.js';

export type { BriefDigest } from '../../domain/objects/project-briefs.js';
export type { SaveIncidentOptions } from '../../domain/objects/incidents.js';

/** The field caps a route checks before it saves, so an over-long field answers 400 before the store is asked. */
export const OBJECT_CAPS = {
  customer: MAX_CUSTOMER_LEN,
  note: MAX_NOTE_LEN,
  noteChange: MAX_SHORT_FIELD_LEN,
  repo: MAX_REPO_LEN,
  briefSummary: MAX_BRIEF_SUMMARY_LEN,
  briefChange: MAX_SHORT_FIELD_LEN,
  processSteps: MAX_PROCESS_STEPS,
  processStep: MAX_PROCESS_STEP_LEN,
  skillName: MAX_SKILL_NAME_LEN,
  skillInstructions: MAX_SKILL_INSTRUCTIONS_LEN,
  skillTrigger: MAX_SKILL_TRIGGER_LEN,
} as const;

/** Opens an incident as the caller; a linked memory outside the caller's tenant refuses the whole write. */
export function incidentOpen(ctx: Context, write: SaveIncidentOptions, origin?: WriteOrigin): Promise<Incident> {
  const { defaultHalfLifeDays } = ctx.config;
  const tagged = taggedFrom(write, origin);
  return openIncident(objectsOf(ctx), defaultHalfLifeDays, ctx.tenantId, tagged, ctx.actor.subject);
}

/** Moves an open incident to resolved as the caller. */
export function incidentResolve(ctx: Context, id: number, resolutionText: string): Promise<Incident> {
  return resolveOpenIncident(objectsOf(ctx), ctx.tenantId, id, resolutionText, ctx.actor.subject);
}

/** The caller's policies in force at `date`, optionally one policy's versions only. */
export function policiesInForce(ctx: Context, date: string, opts: { readonly name?: string }): Promise<Policy[]> {
  return policiesAsOf(objectsOf(ctx), ctx.tenantId, date, { name: opts.name });
}

/** The caller's active skills as one AGENTS.md block; empty when there are none. */
export function skillsExport(ctx: Context): Promise<string> {
  return skillsMarkdown(objectsOf(ctx), ctx.tenantId);
}

/** The brief a refresh of `repo` would save, without saving it. */
export function briefDigest(ctx: Context, repo: string): Promise<BriefDigest> {
  return briefFromReceipts(objectsOf(ctx), ctx.tenantId, repo);
}

/** Saves a new version of the repo's brief from its receipts, as the caller. */
export function briefRefresh(ctx: Context, repo: string): Promise<ProjectBrief> {
  return refreshedBrief(objectsOf(ctx), saveSiteOf(ctx), repo);
}

/** The active decision whose mirror is `memoryId`, or null: what the CLI's `--supersedes <memory-id>` names. */
export function decisionIdByMemory(ctx: Context, memoryId: string): Promise<number | null> {
  return resolveActiveDecisionIdByMemory(objectsOf(ctx), ctx.tenantId, memoryId);
}

/** Weakens the memory a new decision replaces, once that decision has saved. */
export function decisionMemoryWeaken(ctx: Context, entry: MemoryEntry): Promise<void> {
  return weakenSupersededMemory(ctx.store.entryWrites, entry, ctx.actor.subject);
}
