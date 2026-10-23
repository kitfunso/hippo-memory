// This process's home folder and environment, which src/base/util/agent-homes.ts's path rules read: the one place the
// profile folder is asked for.
import * as os from 'node:os';
import * as path from 'node:path';
import { HIPPO_DIR, userHome, type Homes } from '../base/util/agent-homes.js';
import { envHippoHome, envXdgDataHome, processEnv } from '../base/util/env.js';

/** The profile folder and the environment of this process. */
export function processHomes(): Homes {
  return { home: os.homedir(), env: processEnv() };
}

/** This process's home as a HOME or USERPROFILE variable names it, else the profile folder. */
export function homeDir(): string {
  return userHome(processHomes());
}

/** The global Hippo store directory: $HIPPO_HOME, else $XDG_DATA_HOME/hippo, else ~/.hippo. */
export function hippoHomeDir(): string {
  const hippoHome = envHippoHome();
  if (hippoHome) return hippoHome;
  const xdgData = envXdgDataHome();
  if (xdgData) return path.join(xdgData, 'hippo');
  return path.join(os.homedir(), HIPPO_DIR);
}
