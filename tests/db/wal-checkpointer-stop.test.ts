import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHippoDbPath } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT = pathToFileURL(resolve(REPO_ROOT, 'dist', 'db', 'wal-checkpointer.js')).href;

// The test runner keeps its own event loop alive, so only a process with nothing else open shows a stop that ends it.
describe('the WAL checkpointer stop', () => {
  it('settles after its worker started, in a process with nothing else open', () => {
    const dbPath = getHippoDbPath(makeRoot('wal-checkpointer-stop'));
    // 32 responses (RESPONSES_PER_CHECKPOINT) start the worker; the code after the stop must then still run.
    const script = [
      `import { startWalCheckpointer } from ${JSON.stringify(BUILT)};`,
      `const checkpointer = startWalCheckpointer(${JSON.stringify(dbPath)});`,
      'for (let i = 0; i < 32; i++) checkpointer.noteResponse();',
      'await checkpointer.stop();',
      "console.log('stopped');",
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(child.stdout.trim(), `run \`npm run build\` first if the import failed:\n${child.stderr}`).toBe('stopped');
    expect(child.status).toBe(0);
  });
});
