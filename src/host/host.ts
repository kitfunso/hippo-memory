// The process facts a composition root keeps for its life, in one object it builds and passes down: project walks and
// shared-store flags. Nothing here is module state, so two roots in one process never share an answer.
import * as path from 'node:path';
import type { ProjectIdentity } from '../base/scope/project-identity.js';
import { configReader, sharedStoreCheck } from './config-file.js';
import { resolveGlobalRootDir, walkIdentity, type RemoteRule } from './project-identity.js';

export interface Host {
  /** The project `dir` belongs to; each path is walked once while the global remote rule stays as it was. */
  readonly projectIdentity: (dir: string) => ProjectIdentity;
  /** The store's config marks it shared; once true, true for this host, so a broken edit cannot turn it off. */
  readonly isSharedStore: (hippoRoot: string) => boolean;
}

// A walk costs milliseconds and a batch write stamps every row, so each path is walked once per host.
const IDENTITY_CACHE_MAX = 1_000;

/** A root's Host: a CLI command, a server, an MCP host or a store object each build one and drop it with themselves. */
export function createHost(): Host {
  const globalConfig = configReader();
  const remoteOn: RemoteRule = () => globalConfig(resolveGlobalRootDir()).projectIdentity.remote;
  const walks = new Map<string, { readonly identity: ProjectIdentity; readonly remote: boolean | null }>();
  return {
    projectIdentity: (dir) => {
      const start = path.resolve(dir);
      const kept = walks.get(start);
      if (kept && (kept.remote === null || kept.remote === remoteOn())) return kept.identity;
      const { identity, rooted } = walkIdentity(start, undefined, remoteOn);
      if (walks.size >= IDENTITY_CACHE_MAX) walks.delete(walks.keys().next().value!);
      walks.set(start, { identity, remote: rooted ? remoteOn() : null });
      return identity;
    },
    isSharedStore: sharedStoreCheck(),
  };
}

/** The origin for a write that names none: NULL on a shared store, whose folder is no caller's project, else the
 * folder's project. */
export function fallbackOrigin(host: Host, hippoRoot: string): string | null {
  return host.isSharedStore(hippoRoot) ? null : host.projectIdentity(path.dirname(path.resolve(hippoRoot))).name;
}
