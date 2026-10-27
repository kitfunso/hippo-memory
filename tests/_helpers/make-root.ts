import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { initTestStore } from './store-template.js';
import { PRIVATE_DIR } from '../../src/host/private-dir.js';
import { waitFor } from './wait-for.js';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { openStore, storeFilesOf } from '../../src/store/sqlite/handles.js';

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

/** A process a test started; it must be gone before the folder it works in is removed. */
export interface LiveChild {
  readonly lifetime: 'test' | 'file';
  stop(): Promise<void>;
}

const live = new Set<LiveChild>();

/** Registers `child` so removeWhenStopped and this file's hooks stop it before any rm; it leaves the set once stopped. */
export function trackLive(child: LiveChild): void {
  live.add(child);
}

async function stopLive(lifetimes: readonly LiveChild['lifetime'][]): Promise<void> {
  const due = [...live].filter((child) => lifetimes.includes(child.lifetime));
  for (const child of due) live.delete(child);
  await Promise.all(due.map((child) => child.stop()));
}

function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Stops this test's live children, then removes `dir`; afterEach runs before onTestFinished, so an rm in afterEach calls this. */
export async function removeWhenStopped(dir: string): Promise<void> {
  await stopLive(['test']);
  // Windows can refuse the rm for a moment after the last process in the folder exits.
  await waitFor(
    () => {
      rmDir(dir);
      return true;
    },
    { what: `${dir} removed`, retryOnThrow: true },
  );
}

// Removed after the file's last test, not each test's: a store made in beforeAll must outlive its first test.
const made: string[] = [];
afterEach(() => stopLive(['test']));
/** Stops every tracked child, then removes the folders made for this file; it is the file's afterAll. */
export async function endOfFile(): Promise<void> {
  await stopLive(['test', 'file']);
  for (const dir of made.splice(0)) rmDir(dir);
}
afterAll(endOfFile);

function build(label: string, rootOf: (base: string) => string, { config, init = true }: MakeRootOptions): MadeStore {
  const base = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  made.push(base);
  const root = rootOf(base);
  if (!init) return { base, root };
  // makeStore's root is left for initTestStore to create, so it gets the owner-only mode a real store gets.
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
