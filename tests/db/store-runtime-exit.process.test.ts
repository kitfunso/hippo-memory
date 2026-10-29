// process.exit skips every finally, so only the root's exit hook can run held writes and close open handles; a root
// that ends without one removes its hook.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHippoDbPath } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { withStoreRuntime } from '../../src/surface/open-store.js';
import { StoreRuntime } from '../../src/db/store-runtime.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const built = (file: string): string => JSON.stringify(pathToFileURL(resolve(REPO_ROOT, 'dist', file)).href);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('process.exit inside a command store runtime', () => {
  it('runs the held mirror write and closes the open request handle', () => {
    const root = makeRoot('store-runtime-exit');
    const marker = join(root, 'held-write.txt');
    const script = [
      `import * as fs from 'node:fs';`,
      `import { withStoreRuntime } from ${built('surface/open-store.js')};`,
      `import { deferMirrorWrite } from ${built('store/sqlite/folder-files/mirrors.js')};`,
      `import { grantFor } from ${built('store/sqlite/runtime/grant.js')};`,
      `import { withSharedStoreHandles } from ${built('db/index.js')};`,
      `const root = ${JSON.stringify(root)};`,
      'await withStoreRuntime((runtime) => withSharedStoreHandles((session) => {',
      `  const db = grantFor({ session }).open(root);`,
      `  db.exec("INSERT INTO meta(key, value) VALUES ('exit-probe', '1')");`,
      `  const at = { hippoRoot: root, runtime };`,
      `  deferMirrorWrite(at, 'probe', () => fs.writeFileSync(${JSON.stringify(marker)}, 'flushed'));`,
      "  console.log('exiting');",
      '  process.exit(0);',
      '}, { runtime }));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(child.stdout.trim(), `run \`npm run build\` first if the import failed:\n${child.stderr}`).toBe('exiting');
    expect(child.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('flushed');
    // SQLite removes the WAL when the last connection closes cleanly, so its absence shows the handle was closed.
    expect(existsSync(`${getHippoDbPath(root)}-wal`)).toBe(false);
  });
});

describe('withStoreRuntime', () => {
  it('removes its exit hook even when dispose throws', async () => {
    const before = process.listenerCount('exit');
    vi.spyOn(StoreRuntime.prototype, 'dispose').mockRejectedValue(new Error('closeNow threw'));
    let during = 0;
    const run = withStoreRuntime(async () => {
      during = process.listenerCount('exit');
    });
    await expect(run).rejects.toThrow('closeNow threw');
    expect([during, process.listenerCount('exit')]).toEqual([before + 1, before]);
  });
});
