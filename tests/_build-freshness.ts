// vitest globalSetup: many tests spawn the CLI or import workers from dist, so a build older than src would test old code.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

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
  const stale = staleSources(join(REPO, 'src'), join(REPO, 'dist'));
  if (stale.length === 0) return;
  const more = stale.length > 1 ? ` and ${stale.length - 1} more` : '';
  throw new Error(`dist is older than src/${stale[0]}${more}. Run \`npm run build\`, or \`npm test\`, which builds first.`);
}
