import * as path from 'node:path';
import type { ProjectIdentity } from '../base/scope/project-identity.js';
import { configReader, sharedStoreCheck } from './config-file.js';
import { walkIdentity, type RemoteRule } from './project-identity.js';
import { hippoHomeDir } from './agent-homes.js';

export interface Host {
  readonly projectIdentity: (dir: string) => ProjectIdentity;
  readonly isSharedStore: (hippoRoot: string) => boolean;
}

const IDENTITY_CACHE_MAX = 1_000;

/** A root's Host: a CLI command, a server, an MCP host or a store object each build one and drop
 * it with themselves. */
export function createHost(): Host {
  const globalConfig = configReader();
  const remoteOn: RemoteRule = () => globalConfig(hippoHomeDir()).projectIdentity.remote;
  const walks = new Map<
    string,
    { readonly identity: ProjectIdentity; readonly remote: boolean | null }
  >();
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

/** The origin for a write that names none: NULL on a shared store, whose folder is no caller's
 * project, else the folder's project. */
export function fallbackOrigin(host: Host, hippoRoot: string): string | null {
  return host.isSharedStore(hippoRoot)
    ? null
    : host.projectIdentity(path.dirname(path.resolve(hippoRoot))).name;
}
