// The root export of the SQLite handle helpers: same functions as store-kit's, kept here so the 2.x root keeps them.
import {
  closeHippoDb as closeHandle,
  type DatabaseSyncLike as HandleType,
  openHippoDb as openHandle,
  openHippoDbReadOnly as openHandleReadOnly,
} from '../db/index.js';

/** @deprecated Moves to 'hippo-memory/store-kit' in 3.0; import it from there. */
export const openHippoDb = openHandle;
/** @deprecated Moves to 'hippo-memory/store-kit' in 3.0; import it from there. */
export const openHippoDbReadOnly = openHandleReadOnly;
/** @deprecated Moves to 'hippo-memory/store-kit' in 3.0; import it from there. */
export const closeHippoDb = closeHandle;
/** @deprecated Moves to 'hippo-memory/store-kit' in 3.0; import it from there. */
export type DatabaseSyncLike = HandleType;
