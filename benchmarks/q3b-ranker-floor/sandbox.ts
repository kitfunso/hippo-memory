// One sandbox per store: the built CLI and the in-process calls both see it as HIPPO_HOME and as the home directory.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { REPO_ROOT } from './queries.ts';

const HIPPO_JS = join(REPO_ROOT, 'bin', 'hippo.js');
const INIT_ARGS = ['init', '--no-learn', '--no-hooks', '--no-schedule'];
// A CLI call that embeds loads the model first, so the cap is far above run.py's 30 seconds.
const CLI_TIMEOUT_MS = 300_000;
const HOME_KEYS = ['HIPPO_HOME', 'HOME', 'USERPROFILE'] as const;

/** A store's sandbox and the untouched copy every query starts from. */
export interface Site { readonly home: string; readonly snapshot: string }

export interface CliRun { readonly status: number; readonly stdout: string; readonly stderr: string }

/** The built CLI of this checkout, as run.py runs it: the sandbox is HIPPO_HOME and the home directory, so the store walk-up ends there. */
export function runHippo(args: readonly string[], home: string, cwd: string = home): CliRun {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], {
    cwd,
    env: { ...process.env, HIPPO_HOME: home, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** `runHippo` for a command that must succeed; returns its stdout. */
export function hippoOk(args: readonly string[], home: string, cwd: string = home): string {
  const r = runHippo(args, home, cwd);
  if (r.status !== 0) throw new Error(`hippo ${args.join(' ')} exited ${r.status} in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

export function initSandbox(home: string): void {
  mkdirSync(home, { recursive: true });
  hippoOk(INIT_ARGS, home);
}

/** run.py's `_resolve_item_cwd`: the sandbox itself, or a subdirectory of it with its own local store. */
export function resolveItemCwd(home: string, subdir: string | undefined, fixture: string): string {
  if (subdir === undefined) return home;
  if (isAbsolute(subdir) || win32.isAbsolute(subdir) || posix.isAbsolute(subdir) || /^[A-Za-z]:/.test(subdir)) {
    throw new Error(`fixture ${fixture}: cwd_subdir ${subdir} must be a relative path`);
  }
  if (subdir.split(/[\\/]/).includes('..')) throw new Error(`fixture ${fixture}: cwd_subdir ${subdir} must not contain '..'`);
  const target = join(home, subdir);
  mkdirSync(target, { recursive: true });
  // Without its own store the walk-up would find the sandbox store and every subdirectory would share it.
  if (!existsSync(join(target, '.hippo', 'hippo.db'))) hippoOk(INIT_ARGS, home, target);
  return target;
}

export function takeSnapshot(site: Site): void {
  cpSync(site.home, site.snapshot, { recursive: true });
}

/** Puts the snapshot back at the path the store was built at: the path boost reads the directory names of the cwd. */
export function restore(site: Site): void {
  rmSync(site.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cpSync(site.snapshot, site.home, { recursive: true });
}

/** Runs in-process calls as the CLI would run in `cwd` of this sandbox, then puts the process back. */
export async function inSandbox<T>(home: string, cwd: string, fn: () => Promise<T>): Promise<T> {
  const saved = HOME_KEYS.map((key) => [key, process.env[key]] as const);
  const back = process.cwd();
  for (const key of HOME_KEYS) process.env[key] = home;
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    // Windows cannot delete a directory that is some process's cwd, and the next restore deletes this one.
    process.chdir(back);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
