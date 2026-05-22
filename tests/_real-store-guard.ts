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
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolve the global store the way src/shared.ts getGlobalRoot() does:
// HIPPO_HOME, then XDG_DATA_HOME/hippo, then ~/.hippo.
function globalStoreRoot(): string {
  const hippoHome = process.env.HIPPO_HOME?.trim();
  if (hippoHome) return hippoHome;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, 'hippo');
  return join(homedir(), '.hippo');
}

const WATCHED_STORES = [
  join(process.cwd(), '.hippo'), // project-local store
  globalStoreRoot(), // global store (isolated to a temp dir by vitest.config.ts)
];

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
  baseline = WATCHED_STORES.map((dir) => [dir, snapshot(dir)] as const);
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
