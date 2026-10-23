// hippo.db's FolderFiles group: creating its files, and the facts about its folder that rows and labels record.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveProjectIdentity } from '../../host/project-identity.js';
import { realpathOrResolve } from '../../host/real-path.js';
import { blockHash } from '../../base/util/token-text.js';
import type { FolderFiles, StoreHome } from '../port/folder-files.js';
import type { Handles, StoreFiles } from './open.js';
import { openStore } from './handles.js';
import { answered } from './bound.js';

function homeOf({ host, hippoRoot }: StoreFiles): StoreHome {
  const exists = existsSync(hippoRoot);
  const folder = path.dirname(path.resolve(hippoRoot));
  return {
    folder: hippoRoot,
    folderName: path.basename(path.resolve(hippoRoot, '..')),
    // Before the store exists its own marker is missing, so that walk is not kept for the rows it will stamp.
    project: exists ? host.projectIdentity(folder) : resolveProjectIdentity(folder),
    shared: host.isSharedStore(hippoRoot),
    exists,
    hash: blockHash(realpathOrResolve(hippoRoot)),
  };
}

export function sqliteFolderFiles({ on, files }: Handles): FolderFiles {
  return {
    ensure: () => answered(() => on(() => undefined, openStore)),
    home: () => answered(() => homeOf(files)),
  };
}
