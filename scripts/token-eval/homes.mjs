// Per-run directories for every surface that could hold memory, and the checks that they start empty.
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOME_DIRS = ['claudeConfig', 'codexHome', 'hippoHome'];

/** `<out>/runs/<seq>/<arm>/seed<n>/` and the dirs inside it. */
export function runDirs(outDir, seq, arm, seed) {
  const root = path.join(outDir, 'runs', seq, arm, `seed${seed}`);
  return {
    root, seed,
    work: path.join(root, 'work'),
    claudeConfig: path.join(root, 'claude-config'),
    codexHome: path.join(root, 'codex-home'),
    hippoHome: path.join(root, 'hippo-home'),
    bin: path.join(root, 'bin'),
  };
}

/** Throws unless the three home dirs exist and are empty. */
export function assertFreshEmpty(dirs) {
  for (const k of HOME_DIRS) {
    const dir = dirs[k];
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is missing; a run's homes must exist before its first session`);
    const left = fs.readdirSync(dir);
    if (left.length > 0) throw new Error(`${dir} is not empty (${left.slice(0, 5).join(', ')}); a run's homes must start empty`);
  }
}

/** Remove and recreate a run's dirs, then check its homes are empty. */
export function freshRunDirs(dirs) {
  fs.rmSync(dirs.root, { recursive: true, force: true });
  for (const k of [...HOME_DIRS, 'work']) fs.mkdirSync(dirs[k], { recursive: true });
  assertFreshEmpty(dirs);
}

/** Files present in each home, as relative forward-slash paths, for the record. */
export function homeFiles(dirs) {
  const list = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? list(dir, child) : [child];
  });
  return Object.fromEntries(HOME_DIRS.map((k) => [k, fs.existsSync(dirs[k]) ? list(dirs[k]).sort() : []]));
}
