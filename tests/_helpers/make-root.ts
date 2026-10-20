import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { releaseHeldStores } from './held-stores.js';
import { initTestStore } from './store-template.js';

export interface MakeRootOptions {
  /** Written to `<root>/config.json`, where the store reads its config. */
  config?: object;
  /** False for a test that opens, migrates or refuses a folder that is not a store yet: only the temp dir is made. */
  init?: boolean;
}

export interface MadeStore {
  /** The temp dir: a project folder, the cwd of a command, the home of a fake user. */
  base: string;
  /** The initialised store: `<base>/.hippo`. */
  root: string;
}

// Removed after the file's last test, not each test's: a store made in beforeAll must outlive its first test.
const made: string[] = [];
afterAll(() => {
  // A store made after the file's last test is still held.
  releaseHeldStores();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function build(label: string, rootOf: (base: string) => string, { config, init = true }: MakeRootOptions): MadeStore {
  const base = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  made.push(base);
  const root = rootOf(base);
  if (!init) return { base, root };
  // makeStore's root is left for initTestStore to create, so it gets the owner-only mode a real store gets.
  if (root === base) mkdirSync(join(base, '.hippo'), { recursive: true });
  initTestStore(root);
  if (config) writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  return { base, root };
}

/** A temp dir that is itself the store root, with an empty `.hippo` folder inside; removed after the file's last test. */
export function makeRoot(label: string, opts: MakeRootOptions = {}): string {
  return build(label, (base) => base, opts).root;
}

/** A temp project dir holding the store at `<base>/.hippo`, as `hippo init` lays it out; removed after the file's last test. */
export function makeStore(label: string, opts: MakeRootOptions = {}): MadeStore {
  return build(label, (base) => join(base, '.hippo'), opts);
}
