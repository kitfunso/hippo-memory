// A store kept as files in a folder: creating them, and the facts about that folder its rows record, so no caller holds
// the folder's path.
import type { ProjectIdentity } from '../../base/scope/project-identity.js';

export interface FolderFiles {
  /** Creates the store's files when they are missing, as `hippo init`, a first share or a global capture needs. */
  ensure(): Promise<void>;
  /** Where the store sits, read without creating it. */
  home(): Promise<StoreHome>;
}

export interface StoreHome {
  /** The folder as a promoted copy's `promoted:<folder>` source names it. */
  readonly folder: string;
  /** The name of the folder that holds it, which a share's label falls back on. */
  readonly folderName: string;
  /** The project of the folder that holds it; its name is the origin a write naming none takes, unless the store is
   * shared. */
  readonly project: ProjectIdentity;
  /** Its config marks it as a store many people share. */
  readonly shared: boolean;
  /** Its folder exists, so a read there creates nothing. */
  readonly exists: boolean;
  /** The hash its delivery rows name it by. */
  readonly hash: string;
}
