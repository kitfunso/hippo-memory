import type { ProjectIdentity } from '../../scope/project-identity.js';
import type { MethodEffects } from './effects.js';

export interface FolderFiles {
  ensure(): Promise<void>;
  home(): Promise<StoreHome>;
}

/** What each FolderFiles method does to the store; every adapter honours it. */
export const FOLDER_FILES_EFFECTS = {
  ensure: 'write',
  home: 'read',
} as const satisfies MethodEffects<FolderFiles>;

export interface StoreHome {
  readonly folder: string;
  readonly folderName: string;
  readonly project: ProjectIdentity;
  readonly shared: boolean;
  readonly exists: boolean;
  readonly hash: string;
}
