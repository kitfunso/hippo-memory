import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function globalStoreRoot(): string {
  const hippoHome = process.env.HIPPO_HOME?.trim();
  if (hippoHome) return hippoHome;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, 'hippo');
  return join(homedir(), '.hippo');
}

function realpathOrResolve(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function watchedStoreDirs(cwd: string, home: string): string[] {
  const homeReal = realpathOrResolve(home);
  const tmpReal = realpathOrResolve(tmpdir());
  const dirs: string[] = [];
  const add = (d: string): void => {
    if (!dirs.some((x) => samePath(x, d))) dirs.push(d);
  };
  let dir = realpathOrResolve(cwd);
  add(join(dir, '.hippo'));
  for (;;) {
    if (samePath(dir, homeReal) || samePath(dir, tmpReal)) break;
    add(join(dir, '.hippo'));
    const parent = dirname(dir);
    if (samePath(parent, dir)) break;
    dir = parent;
  }
  add(globalStoreRoot());
  return dirs;
}

export function snapshot(dir: string): string {
  if (!existsSync(dir)) return '<absent>';
  if (!statSync(dir).isDirectory()) return '<not-a-directory>';
  const files: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else files.push(`${r}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir, '');
  return files.join('\n');
}

let baseline: Array<readonly [string, string]> = [];

export function setup(): void {
  const realHome = process.env.HIPPO_TEST_REAL_HOME || homedir();
  baseline = watchedStoreDirs(process.cwd(), realHome).map((dir) => [dir, snapshot(dir)] as const);
}

export function teardown(): void {
  const leaked = baseline.filter(([dir, snap]) => snapshot(dir) !== snap).map(([dir]) => dir);

  // The removal is swallowed on failure: vitest turns a globalSetup teardown
  // throw into process.exitCode = 1, so a stray Windows EBUSY here would itself
  // fail the run — the exact intermittent failure this isolation prevents.
  if (leaked.length === 0) {
    const realTmp = process.env.HIPPO_TEST_REAL_TMP?.trim() || tmpdir();
    const env = process.env;
    for (const dir of [
      env.HIPPO_TEST_TMP_HOME?.trim(),
      env.HIPPO_TEST_TMP_USERHOME?.trim(),
      env.HIPPO_TEST_TMP_RUN?.trim(),
    ]) {
      if (dir && dir.startsWith(realTmp) && /[\\/]hippo-test-(home|userhome|tmp)-[^\\/]+$/.test(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch (err) {
          console.warn(
            `[real-store-guard] could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return;
  }

  throw new Error(
    `Test-isolation leak: the test run mutated hippo store(s): ` +
      `${leaked.join(', ')}. Either a test wrote a store without isolating it ` +
      `(isolate the local store via the spawn 'cwd' option and the global ` +
      `store via a per-test HIPPO_HOME), or an ancestor store listed above was ` +
      `written from outside this suite while it ran. Re-run with ` +
      `--no-file-parallelism to attribute the leak to a test file.`,
  );
}
