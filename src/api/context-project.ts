// Which project a context read is for, decided from the facts of the request.
import { dirname, resolve } from 'node:path';
import { assertCallerProject, type ProjectRef } from '../base/scope/project-identity.js';
import { sharedStoreOf, type Context } from './types.js';

/** What a request says about its project: the store folder it reached, and the `project` and
 * `alias` it named. */
export interface ProjectFacts {
  readonly storeDir: string;
  readonly project: string | null;
  readonly aliases: readonly string[];
}

/**
 * A shared store's folder is no caller's project, so the caller names it; with none, contextGet
 * refuses. Any other store is the project of the folder it sits in.
 *
 */
export function contextProjectFor(
  ctx: Context,
  { storeDir, project, aliases }: ProjectFacts,
): ProjectRef {
  if (!sharedStoreOf(ctx)) return ctx.infra.machine.projectIdentity(dirname(resolve(storeDir)));
  if (project === null) return '';
  assertCallerProject({ name: project, aliases });
  return { name: project, legacyName: project, aliases: [...aliases] };
}
