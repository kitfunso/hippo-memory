import type { HippoStore, StoreWith } from '../store.js';

/** The groups share, sync and promote use on the operator's global store. */
export type GlobalTargetGroup =
  | 'promotion'
  | 'sharing'
  | 'folderFiles'
  | 'embeddingIndex'
  | 'captures'
  | 'lessonWrites'
  | 'rejections'
  | 'vectors'
  | 'vectorWrites';

/** The groups the operator's global store sets for a reader: churn's marks, the ledger, and the
 * session rows a folder with no store of its own ends its sessions in. */
export type GlobalGroup = 'learning' | 'ledger' | 'folderFiles' | 'sessions';

/** A store and the folder its root opened it from; the folder is for the root's own config read. */
export interface FolderStore<S extends HippoStore = HippoStore> {
  readonly root: string;
  readonly store: S;
}

export interface StoreReach {
  readonly hasLocal: boolean; // the primary store has a project of its own, or has no local files
  readonly isGlobal: boolean; // the primary root is the operator's global store
  readonly shared: boolean; // a store serving many people, so the operator's global store stays out
  readonly global?: FolderStore<StoreWith<GlobalGroup>>;
  readonly isHippoDb?: boolean;
  readonly globalTarget?: FolderStore<StoreWith<GlobalTargetGroup>>;
}
