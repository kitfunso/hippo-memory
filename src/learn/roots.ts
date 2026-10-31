// The one place the learn passes open hippo.db by folder; the passes themselves take a Learning.
import type { LocalFiles } from '../store/port/local-files.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';

export function localFilesAt(hippoRoot: string): LocalFiles {
  return sqliteSyncStore(hippoRoot).localFiles;
}
