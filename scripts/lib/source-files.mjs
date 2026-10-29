// One walk over the source folders for the scripts that read every file in them.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** The sources under `dir` of `root` as `dir/...` paths; node_modules and declaration files load nothing, so are left out. */
export function listSources(root, dir) {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(root, rel);
    return SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [rel] : [];
  });
}
