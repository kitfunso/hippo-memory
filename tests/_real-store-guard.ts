/**
 * Test-isolation guard (vitest `globalSetup` — see vitest.config.ts).
 *
 * Snapshots the developer's real hippo stores before the test run and fails
 * the run if it ends with either store mutated. Tests must write only to temp
 * dirs: isolate the *local* store with the spawn `cwd` option and the *global*
 * store with the `HIPPO_HOME` env var. To attribute a leak to a single test
 * file, re-run with `--no-file-parallelism`.
 *
 * The filename has no `.test.` segment, so vitest's `include` glob does not
 * collect it as a test file.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REAL_STORES = [
  join(process.cwd(), '.hippo'), // project-local store
  join(homedir(), '.hippo'), // global store
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
      else files.push(`${r}:${st.size}`);
    }
  };
  walk(dir, '');
  return files.join('\n');
}

let baseline: Array<readonly [string, string]> = [];

export function setup(): void {
  baseline = REAL_STORES.map((dir) => [dir, snapshot(dir)] as const);
}

export function teardown(): void {
  const leaked = baseline.filter(([dir, snap]) => snapshot(dir) !== snap);
  if (leaked.length > 0) {
    throw new Error(
      `Test-isolation leak: the test run mutated real hippo store(s): ` +
        `${leaked.map(([dir]) => dir).join(', ')}. Tests must write only to ` +
        `temp dirs — isolate the local store via the spawn 'cwd' option and ` +
        `the global store via the HIPPO_HOME env var. Re-run with ` +
        `--no-file-parallelism to attribute the leak to a test file.`,
    );
  }
}
