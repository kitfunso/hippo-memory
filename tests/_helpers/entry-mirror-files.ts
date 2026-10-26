import * as fs from 'node:fs';
import * as path from 'node:path';

const LAYER_DIRS = ['buffer', 'episodic', 'semantic', 'trace'];

/** The markdown mirror files for `id` still on disk under the store's layer folders. */
export function entryMirrorFiles(root: string, id: string): string[] {
  return LAYER_DIRS.map((dir) => path.join(root, dir, `${id}.md`)).filter((file) => fs.existsSync(file));
}
