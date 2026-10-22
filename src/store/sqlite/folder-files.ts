// hippo.db's FolderFiles group: creating its files, and the facts about its folder that rows and labels record.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isSharedStore } from '../../base/config/config.js';
import { resolveProjectIdentity } from '../../base/scope/project-identity.js';
import { realpathOrResolve } from '../../base/util/real-path.js';
import { blockHash } from '../../base/util/token-text.js';
import type { FolderFiles, StoreHome } from '../port/folder-files.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { answered } from './bound.js';

function homeOf(hippoRoot: string): StoreHome {
  return {
    folder: hippoRoot,
    folderName: path.basename(path.resolve(hippoRoot, '..')),
    project: resolveProjectIdentity(path.dirname(path.resolve(hippoRoot))),
    shared: isSharedStore(hippoRoot),
    exists: existsSync(hippoRoot),
    hash: blockHash(realpathOrResolve(hippoRoot)),
  };
}

export function sqliteFolderFiles({ on, files }: Handles): FolderFiles {
  return {
    ensure: () => answered(() => on(() => undefined, openStore)),
    home: () => answered(() => homeOf(files.hippoRoot)),
  };
}
