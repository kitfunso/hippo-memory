import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveProjectIdentity } from '../../../host/project-identity.js';
import { realpathOrResolve } from '../../../host/real-path.js';
import { blockHash } from '../../../base/util/token-text.js';
import type { FolderFiles, StoreHome } from '../../../base/ports/store/folder-files.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { answered } from '../runtime/bound.js';

function homeOf({ host, hippoRoot }: StoreFiles): StoreHome {
  const exists = existsSync(hippoRoot);
  const folder = path.dirname(path.resolve(hippoRoot));
  return {
    folder: hippoRoot,
    folderName: path.basename(path.resolve(hippoRoot, '..')),
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
