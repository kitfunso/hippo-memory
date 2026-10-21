// The disk reader and git runner currentMachine() carries, for test machines built on a scratch home.
import { diskAgentFiles } from '../../src/base/util/agent-files.js';
import { processGit } from '../../src/infra/git-runner.js';

export const REAL_IO = { files: diskAgentFiles, git: processGit } as const;
