// hippo.db's own refusals: each is a StoreBlockedError, so the layers above map it to 501 by the
// base class alone.
import { StoreBlockedError } from '../base/util/store-blocked.js';

/** A hippo.db open refused: a folder marked for another store, or a store whose SQLite work runs
 * on worker threads. */
export class SqliteBlockedError extends StoreBlockedError {
  constructor(storeKind: string, message: string) {
    super(storeKind, message);
    this.name = 'SqliteBlockedError';
  }
}

/** A hippo.db open in a folder whose marker names the store that holds its memories, from the
 * CLI as from a request. */
export class OtherStoreFolderError extends SqliteBlockedError {
  constructor(
    storeKind: string,
    readonly markerPath: string,
  ) {
    super(
      storeKind,
      `This folder's memories live in the '${storeKind}' store, so hippo.db is not used here (marker: ${markerPath})`,
    );
    this.name = 'OtherStoreFolderError';
  }
}
