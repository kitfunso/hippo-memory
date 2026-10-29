import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { workspaceRegistryPath } from '../../src/surface/cli/scheduler.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { PRIVATE_DIR } from '../../src/host/private-dir.js';

// About 2 s solo, two runs of two short child steps, so the 30 s process-project timeout is a 15x margin.
describe('hippo daily-runner', () => {
  it('stops a child step at its deadline, names the workspace and reason, and exits 1 so the scheduler sees the failure', async () => {
    const dir = realpathSync(makeRoot('daily-runner', { init: false }));
    const globalRoot = join(dir, 'global');
    const workspace = join(dir, 'repo');
    mkdirSync(globalRoot);
    mkdirSync(join(workspace, '.hippo'), PRIVATE_DIR);
    initTestStore(join(workspace, '.hippo'));
    writeFileSync(workspaceRegistryPath(globalRoot), JSON.stringify({ version: 1, workspaces: [workspace] }));
    // The runner runs in process so coverage sees it; each step it starts is still a real child with a real deadline.
    const run = (extraEnv: Record<string, string>) =>
      runCliAs(['daily-runner'], {
        cwd: dir,
        env: {
          ...process.env,
          HIPPO_HOME: globalRoot,
          HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
          HIPPO_LOG: 'warn',
          HIPPO_LOG_FORMAT: '',
          ...extraEnv,
        },
      });

    // One millisecond is less than a node start, so both child steps are stopped at the deadline.
    const cut = await run({ HIPPO_DAILY_STEP_TIMEOUT_MS: '1' });
    expect(cut.stdout).toContain('0 workspaces processed, 2 command failures.');
    expect(cut.stderr).toMatch(
      /error: daily-runner failed in .*repo during `sleep`: timed out after 1 ms and was stopped .*workspace=.*repo/,
    );
    expect(cut.stderr).toMatch(/daily-runner failed in .*workspace=.* errorClass=\w+ stack=\S*Error.* at /);
    expect(cut.status).toBe(1);

    // Control: the same workspace inside the default deadline is a clean run.
    const clean = await run({});
    expect(clean.stdout).toContain('1 workspace processed, 0 command failures.');
    expect(clean.status).toBe(0);
  });
});
