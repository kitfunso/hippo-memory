// What a project is and how a reader's rows match it: the nearest ancestor with `.hippo` (else `.git`), and never
// home or the temp root. Its name: `.hippo-project.json`, else the normalized `origin`, else the folder name.
// src/host/project-identity.ts walks the disk to resolve one.
import { BadRequestError } from '../errors/api-errors.js';
import { MAX_ID_LEN } from '../util/limits.js';

/** The project a working directory belongs to. */
export interface ProjectIdentity {
  /** Realpath-resolved root directory of the project (the start dir when not in a project). */
  root: string;
  /** The project id rows are stamped with: the project file's id, the origin remote, or legacyName; '' outside a
   * project. */
  name: string;
  /** The folder rule rows written before ids carry: the root's lowercased basename, or its repo's for a linked worktree
   * with no `.hippo`. */
  legacyName: string;
  /** Every other name this root resolves to (the project file id, the origin remote even with the rule off,
   * legacyName), so rows written under an earlier id stay readable. */
  aliases?: readonly string[];
  /** True when the directory resolves to the user home working set. */
  isHome: boolean;
}

/** Options for resolveProjectIdentity. Both fields are test seams; stopDir bounds the upward walk so tests in a temp
 * sandbox never reach the host's real markers. */
export interface ResolveProjectIdentityOpts {
  homeDir?: string;
  stopDir?: string;
}

/** A reader's project: a bare name, or an identity whose own rows may also carry its legacy folder name. */
export type ProjectRef = string | Pick<ProjectIdentity, 'name' | 'legacyName' | 'aliases'>;

function isBareName(project: ProjectRef): project is string {
  return typeof project === 'string';
}

/** The id a reader's new rows are stamped with; '' outside a project. */
export function projectId(project: ProjectRef): string {
  return isBareName(project) ? project : project.name;
}

/** Every origin_project value the reader's own rows carry: the id first, then each alias and the legacy name. */
export function projectNames(project: ProjectRef): readonly string[] {
  if (isBareName(project) || project.name === '') return [projectId(project)];
  return [...new Set([project.name, ...(project.aliases ?? []), project.legacyName])].filter((n) => n !== '');
}

// Each project name is matched against every candidate row, so the caller's list stays short.
export const MAX_PROJECT_ALIASES = 10;
export const MCP_PROJECT_SCOPED_HEADER = 'X-Hippo-Project-Scoped';

/** Refuses a caller's project that is blank (it would stamp user-global), past the caps, or unlike the resolver's ids:
 * rows match verbatim, so a rewrite would split a project. Inner spaces pass, since a checkout with no remote is named
 * by its folder. */
export function assertCallerProject(project: { readonly name: string; readonly aliases?: readonly string[] }): void {
  const { name, aliases = [] } = project;
  if (name.trim() === '') throw new BadRequestError('project name must not be blank');
  if (aliases.length > MAX_PROJECT_ALIASES) {
    throw new BadRequestError(`project aliases: at most ${MAX_PROJECT_ALIASES}`);
  }
  if ([name, ...aliases].some((n) => n.length > MAX_ID_LEN)) {
    throw new BadRequestError(`project names: at most ${MAX_ID_LEN} characters each`);
  }
  if ([name, ...aliases].some((n) => n !== n.trim().toLowerCase() || /[:\p{Cc}]/u.test(n))) {
    throw new BadRequestError('project names: lowercase, not padded, with no colon or control character');
  }
}

/** Classifies a memory's origin_project against the active project. An empty current id (home or markerless cwd) puts
 * everything in scope; NULL/undefined origin (legacy row, or a shared-store write naming none) counts as cross-project:
 * deny by default for a security partition. */
export function classifyOriginProject(
  origin: string | null | undefined,
  current: ProjectRef,
): 'project' | 'user-global' | 'cross-project' {
  if (projectId(current) === '') return 'project';
  if (origin === undefined || origin === null) return 'cross-project';
  if (origin === '') return 'user-global';
  return projectNames(current).includes(origin) ? 'project' : 'cross-project';
}
