import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../../src/store/sqlite/handles.js';

/** A project dir with its own `.hippo` store plus a sibling `global-hippo` dir to point HIPPO_HOME at. */
export interface TestEnv {
  cwd: string;
  hippoRoot: string;
  globalRoot: string;
}

/** Temp dir named `hippo-<label>-*`; the caller removes `cwd`. `initGlobal` also initialises the global store. */
export function makeEnv(label: string, opts: { initGlobal?: boolean } = {}): TestEnv {
  const cwd = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  const hippoRoot = join(cwd, '.hippo');
  const globalRoot = join(cwd, 'global-hippo');
  mkdirSync(globalRoot, { recursive: true });
  initStore(hippoRoot);
  if (opts.initGlobal) initStore(globalRoot);
  return { cwd, hippoRoot, globalRoot };
}
