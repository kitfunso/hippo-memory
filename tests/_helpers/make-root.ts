import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { initTestStore } from './store-template.js';
import { PRIVATE_DIR } from '../../src/host/private-dir.js';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { openStore, storeFilesOf } from '../../src/store/sqlite/runtime/handles.js';

export interface MakeRootOptions {
  config?: object;
  init?: boolean;
}

export interface MadeStore {
  base: string;
  root: string;
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function build(label: string, rootOf: (base: string) => string, { config, init = true }: MakeRootOptions): MadeStore {
  const base = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  made.push(base);
  const root = rootOf(base);
  if (!init) return { base, root };
  if (root === base) mkdirSync(join(base, '.hippo'), PRIVATE_DIR);
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

/** openStore on a root makeRoot or makeStore made, with the store's own grant: the opener onHandle takes. */
export function openStoreAt(root: string): DatabaseSyncLike {
  return openStore(root, storeFilesOf(root).opens);
}
