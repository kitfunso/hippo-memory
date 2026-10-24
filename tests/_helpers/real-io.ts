// The disk reader, git runner and project walks currentMachine() carries, for test machines built on a scratch home.
import { diskAgentFiles } from '../../src/infra/agent-files.js';
import { processGit } from '../../src/infra/git-runner.js';
import { isGlobalStoreRoot, resolveProjectIdentity } from '../../src/host/project-identity.js';
import { hippoHomeDir } from '../../src/host/agent-homes.js';

export const REAL_IO = {
  files: diskAgentFiles,
  git: processGit,
  projectIdentity: (dir: string) => resolveProjectIdentity(dir),
  globalRoot: hippoHomeDir,
  isGlobalRoot: isGlobalStoreRoot,
} as const;
