// The machine this process runs on, with its real disk reader and git: what a root hands the agent-memory adapters.
import * as os from 'node:os';
import { diskAgentFiles } from '../base/util/agent-files.js';
import type { Machine } from '../base/util/agent-homes.js';
import { processEnv } from '../base/util/env.js';
import { processGit } from './git-runner.js';

export function currentMachine(): Machine {
  return {
    home: os.homedir(),
    env: processEnv(),
    platform: process.platform,
    files: diskAgentFiles,
    git: processGit,
    cwd: process.cwd(),
  };
}
