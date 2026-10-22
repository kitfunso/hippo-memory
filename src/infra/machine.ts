// The machine this process runs on, with its real disk reader and git: what a root hands the agent-memory adapters.
import { diskAgentFiles } from './agent-files.js';
import type { Machine } from '../base/util/agent-homes.js';
import { processHomes } from '../host/agent-homes.js';
import { createHost, type Host } from '../host/host.js';
import { isGlobalStoreRoot, resolveGlobalRootDir } from '../host/project-identity.js';
import { processGit } from './git-runner.js';

/** This machine as `host` sees it; a root passes the Host it keeps, so its project walks outlive one call. */
export function currentMachine(host: Host = createHost()): Machine {
  return {
    ...processHomes(),
    platform: process.platform,
    files: diskAgentFiles,
    git: processGit,
    cwd: process.cwd(),
    projectIdentity: host.projectIdentity,
    globalRoot: resolveGlobalRootDir,
    isGlobalRoot: isGlobalStoreRoot,
  };
}
