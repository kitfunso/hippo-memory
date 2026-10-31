// vitest globalSetup: many tests spawn the CLI or import workers from dist, so a build older than src would test old code.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lockfile = { packages?: Record<string, { version?: string }> };
// SAFETY: npm writes these files, and every field read from them is typed optional and checked before use.
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

// vitest 3 evaluates vitest.config.ts once per project, which splits the store guard from the workers' home, so a stale install must stop the run.
/** Direct dependencies whose installed version is not the one package-lock.json pins, as `name installed, locked version` lines. */
export function staleDependencies(repo: string): string[] {
  const manifest = readJson<Manifest>(join(repo, 'package.json'));
  const locked = readJson<Lockfile>(join(repo, 'package-lock.json')).packages ?? {};
  const stale: string[] = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const want = locked[`node_modules/${name}`]?.version;
    const installedManifest = join(repo, 'node_modules', name, 'package.json');
    const installed = existsSync(installedManifest) ? readJson<{ version?: string }>(installedManifest).version : 'missing';
    if (want !== undefined && installed !== want) stale.push(`${name} ${installed}, locked ${want}`);
  }
  return stale.sort();
}

/** Source files, relative to `srcDir`, whose build output is missing or older than the source. */
export function staleSources(srcDir: string, distDir: string): string[] {
  const stale: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const src = join(entry.parentPath, entry.name);
    const rel = relative(srcDir, src);
    const built = statSync(join(distDir, rel.replace(/\.ts$/, '.js')), { throwIfNoEntry: false });
    if (built === undefined || statSync(src).mtimeMs > built.mtimeMs) stale.push(rel.replaceAll('\\', '/'));
  }
  return stale.sort();
}

export function setup(): void {
  const drift = staleDependencies(REPO);
  if (drift.length > 0) {
    throw new Error(`node_modules does not match package-lock.json (${drift.join('; ')}). Run \`npm ci\`, or link node_modules to an install of this lockfile.`);
  }
  const stale = staleSources(join(REPO, 'src'), join(REPO, 'dist'));
  if (stale.length === 0) return;
  const more = stale.length > 1 ? ` and ${stale.length - 1} more` : '';
  throw new Error(`dist is older than src/${stale[0]}${more}. Run \`npm run build\`, or \`npm test\`, which builds first.`);
}
