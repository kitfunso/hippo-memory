// The SQLite handle helpers the 2.x package root still exports; the root drops them in 3.0.
import {
  closeHippoDb as closeHandle,
  type DatabaseSyncLike as HandleType,
  openHippoDb as openHandle,
  openHippoDbReadOnly as openHandleReadOnly,
} from '../db/index.js';

/** @deprecated The package root stops exporting this in 3.0. */
export const openHippoDb = openHandle;
/** @deprecated The package root stops exporting this in 3.0. */
export const openHippoDbReadOnly = openHandleReadOnly;
/** @deprecated The package root stops exporting this in 3.0. */
export const closeHippoDb = closeHandle;
/** @deprecated The package root stops exporting this in 3.0. */
export type DatabaseSyncLike = HandleType;
