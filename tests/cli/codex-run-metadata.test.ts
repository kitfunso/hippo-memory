// codex-run starts whatever launcher the wrapper metadata names, and any process of the user can rewrite that file, so
// it starts only the backup the installer made.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { makeRoot } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

let dir: string;

beforeEach(() => {
  dir = makeRoot('codex-run', { init: false });
});

it.each([
  // Node stands in for the hostile launcher, so a started launcher runs the script that leaves the sentinel.
  [
    'names a launcher the installer never wrote',
    () => JSON.stringify({ realCodexPath: process.execPath, logFile: 'x' }),
  ],
  ['is not JSON', () => '{ not json'],
])('starts nothing when the metadata %s, and names the file to reinstall', async (_label, metadata) => {
  const metadataPath = path.join(dir, '.hippo', 'integrations', 'codex.json');
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, metadata());
  const sentinel = path.join(dir, 'launched');
  const script = path.join(dir, 'leave-sentinel.mjs');
  fs.writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran');\n`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    HIPPO_HOME: path.join(dir, 'global'),
    CODEX_HOME: path.join(dir, '.codex'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
  };
  const run = await runCliAs(['codex-run', '--', script], { cwd: dir, env });

  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain(
    `${metadataPath} does not describe a Codex wrapper hippo installed, so Codex was not ` +
      'started. Run `hippo hook install codex` again.',
  );
  expect(fs.existsSync(sentinel)).toBe(false);
});
