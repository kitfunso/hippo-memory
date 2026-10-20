// A config.json that exists but cannot be reached must stop the load, as an unparseable one does: defaults would
// silently drop the user's settings.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configReader, isSharedStore, loadConfig } from '../../src/base/config/config.js';
import { makeRoot } from '../_helpers/make-root.js';

// chmod cannot deny access on win32, and root ignores mode bits.
const modeBitsDoNotBind = process.platform === 'win32' || process.getuid?.() === 0;

let locked: string | undefined;
afterEach(() => {
  if (locked !== undefined) chmodSync(locked, 0o700);
  locked = undefined;
});

/** A store folder whose config.json cannot be stat'ed: the folder keeps read but loses search permission. */
function rootWithUnreachableConfig(): string {
  const root = makeRoot('config-unreadable', { init: false });
  writeFileSync(join(root, 'config.json'), '{"defaultHalfLifeDays": 12}');
  chmodSync(root, 0o600);
  locked = root;
  return root;
}

describe.skipIf(modeBitsDoNotBind)(
  'a config.json behind a folder that denies search (skipped on win32 and as root)',
  () => {
    const message = (root: string): string => `${join(root, 'config.json')} could not be reached (EACCES)`;

    it('makes loadConfig throw with the path, the code and the fix, not return the defaults', () => {
      const root = rootWithUnreachableConfig();
      expect(() => loadConfig(root)).toThrow(message(root));
      expect(() => loadConfig(root)).toThrow('Fix the permissions on the file and its folder');
    });

    it('makes a configReader and isSharedStore throw the same way', () => {
      const root = rootWithUnreachableConfig();
      expect(() => configReader()(root)).toThrow(message(root));
      expect(() => isSharedStore(root)).toThrow(message(root));
    });
  },
);

describe('a config.json that is not there', () => {
  it('still loads the defaults when the file is missing', () => {
    const root = makeRoot('config-missing', { init: false });
    expect(loadConfig(root).defaultHalfLifeDays).toBe(loadConfig('').defaultHalfLifeDays);
  });

  it('still loads the defaults when a parent of the path is a file (ENOTDIR)', () => {
    const root = makeRoot('config-enotdir', { init: false });
    const notAFolder = join(root, 'plain-file');
    writeFileSync(notAFolder, 'x');
    expect(loadConfig(notAFolder).defaultHalfLifeDays).toBe(loadConfig('').defaultHalfLifeDays);
  });
});
