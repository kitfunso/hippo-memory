// The typed-object saves as evals and tests seed them: one tenant, one half-life, the CLI actor, at
// HIPPO_FAKE_NOW or the wall clock.
import type { Objects } from '../base/records/objects.js';
import type { CustomerNote, Decision, Policy, ProjectBrief } from '../base/records/object-types.js';
import { CLI_ACTOR } from '../base/scope/actor.js';
import { evalNow } from '../infra/eval-switches.js';
import { CUSTOMER_NOTE, type SaveCustomerNoteOptions } from '../domain/objects/customer-notes.js';
import { DECISION, type SaveDecisionOptions } from '../domain/objects/decisions.js';
import { saveObject, type ObjectSaveSite } from '../domain/objects/lifecycle.js';
import { POLICY, type SavePolicyOptions } from '../domain/objects/policies.js';
import { PROJECT_BRIEF, type SaveProjectBriefOptions } from '../domain/objects/project-briefs.js';

function siteOf(baseHalfLifeDays: number, tenantId: string, actor: string): ObjectSaveSite {
  return { baseHalfLifeDays, tenantId, actor, now: evalNow() };
}

export function saveDecision(
  objects: Objects,
  baseHalfLifeDays: number,
  tenantId: string,
  opts: SaveDecisionOptions,
  actor: string = CLI_ACTOR,
): Promise<Decision> {
  return saveObject(objects, DECISION, siteOf(baseHalfLifeDays, tenantId, actor), opts);
}

export function savePolicy(
  objects: Objects,
  baseHalfLifeDays: number,
  tenantId: string,
  opts: SavePolicyOptions,
  actor: string = CLI_ACTOR,
): Promise<Policy> {
  return saveObject(objects, POLICY, siteOf(baseHalfLifeDays, tenantId, actor), opts);
}

export function saveCustomerNote(
  objects: Objects,
  baseHalfLifeDays: number,
  tenantId: string,
  opts: SaveCustomerNoteOptions,
  actor: string = CLI_ACTOR,
): Promise<CustomerNote> {
  return saveObject(objects, CUSTOMER_NOTE, siteOf(baseHalfLifeDays, tenantId, actor), opts);
}

export function saveProjectBrief(
  objects: Objects,
  baseHalfLifeDays: number,
  tenantId: string,
  opts: SaveProjectBriefOptions,
  actor: string = CLI_ACTOR,
): Promise<ProjectBrief> {
  return saveObject(objects, PROJECT_BRIEF, siteOf(baseHalfLifeDays, tenantId, actor), opts);
}
