/**
 * Test-isolation guard (vitest `globalSetup` — see vitest.config.ts).
 *
 * vitest.config.ts points HIPPO_HOME at a fresh per-run temp dir, so the whole
 * test run resolves the global hippo store to an isolated location no external
 * process touches. This guard snapshots that isolated global store and the
 * project-local store (process.cwd()/.hippo) before the run and fails the run
 * if a test left either mutated — catching a test that writes a store without
 * isolating it. On a clean run, teardown() removes the isolated temp dir.
 *
 * Tests must write only to temp dirs: isolate the local store with the spawn
 * `cwd` option and the global store with a per-test `HIPPO_HOME`.
 *
 * The filename has no `.test.` segment, so vitest's `include` glob does not
 * collect it as a test file.
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Resolve the global store the way src/shared.ts getGlobalRoot() does:
// HIPPO_HOME, then XDG_DATA_HOME/hippo, then ~/.hippo.
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

// Mirrors src/project-identity.ts's walkProjectMarkers: home/tmpdir stop before the marker check, root stops after.
export function watchedStoreDirs(cwd: string, home: string): string[] {
  const homeReal = realpathOrResolve(home);
  const tmpReal = realpathOrResolve(tmpdir());
  const dirs: string[] = [];
  let dir = realpathOrResolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (samePath(dir, homeReal) || samePath(dir, tmpReal)) break;
    // Every ancestor's store is listed even when absent: a test can create one mid-run.
    dirs.push(join(dir, '.hippo'));
    const parent = dirname(dir);
    if (samePath(parent, dir)) break; // filesystem root, already pushed above
    dir = parent;
  }
  const global = globalStoreRoot();
  if (!dirs.some((d) => samePath(d, global))) dirs.push(global); // HIPPO_HOME can collide with an ancestor
  return dirs;
}

function snapshot(dir: string): string {
  if (!existsSync(dir)) return '<absent>';
  const files: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      // size + mtime so a same-size in-place rewrite is still caught.
      else files.push(`${r}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir, '');
  return files.join('\n');
}

let baseline: Array<readonly [string, string]> = [];

export function setup(): void {
  // This shell is itself a Claude Code session; the var would leak into every spawned CLI
  // child and falsify null-session_id trace assertions, so drop it before workers fork.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  baseline = watchedStoreDirs(process.cwd(), homedir()).map((dir) => [dir, snapshot(dir)] as const);
}

export function teardown(): void {
  // (1) compute the leak verdict and (2) capture the leaked store paths.
  const leaked = baseline
    .filter(([dir, snap]) => snapshot(dir) !== snap)
    .map(([dir]) => dir);

  // (3) on a clean run, remove the per-run temp store vitest.config.ts created.
  // The removal is swallowed on failure: vitest turns a globalSetup teardown
  // throw into process.exitCode = 1, so a stray Windows EBUSY here would itself
  // fail the run — the exact intermittent failure this isolation prevents.
  if (leaked.length === 0) {
    // Defence-in-depth on a destructive op: only remove a directory that is
    // under the OS temp dir and carries vitest.config.ts's mkdtemp prefix, so
    // the rmSync is safe by construction, not merely by the variable's name.
    const tmpHome = process.env.HIPPO_TEST_TMP_HOME?.trim();
    if (
      tmpHome &&
      tmpHome.startsWith(tmpdir()) &&
      /[\\/]hippo-test-home-[^\\/]+$/.test(tmpHome)
    ) {
      try {
        rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best-effort; the OS temp sweep reclaims it */
      }
    }
    return;
  }

  // (4) on a leak, leave the temp dir for inspection and fail the run.
  throw new Error(
    `Test-isolation leak: the test run mutated hippo store(s): ` +
      `${leaked.join(', ')}. A test wrote a store without isolating it — ` +
      `isolate the local store via the spawn 'cwd' option and the global ` +
      `store via a per-test HIPPO_HOME. Re-run with --no-file-parallelism ` +
      `to attribute the leak to a test file.`,
  );
}
