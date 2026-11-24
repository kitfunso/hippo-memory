import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// SHORTCUT: a sub-page tracks its own file only; date shared content too if those edits start to matter.
const HOME_SOURCES = ['src/pages/index.astro', 'src/content/site.ts', 'src/components'];

export function sourcesFor(pathname) {
  const route = pathname.replace(/^\/|\/$/g, '');
  if (!route) return HOME_SOURCES;
  const file = `src/pages/${route}.astro`;
  if (!existsSync(file)) throw new Error(`no page file for ${pathname}: expected ${file}`);
  return [file];
}

export function pageDate(pathname) {
  const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...sourcesFor(pathname)], { encoding: 'utf8' }).trim();
  return date || new Date().toISOString().slice(0, 10);
}
