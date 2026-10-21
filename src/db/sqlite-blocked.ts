// hippo.db's own refusals: each is a StoreBlockedError, so the layers above map it to 501 by the base class alone.
import { StoreBlockedError } from '../base/util/store-blocked.js';

/** A hippo.db open inside a request another store serves: the code path is not ported to the store port yet. */
export class SqliteBlockedError extends StoreBlockedError {
  constructor(
    storeKind: string,
    message = `hippo.db is not opened while the '${storeKind}' store serves this request; this code path is not ` +
      `ported to the store yet`,
  ) {
    super(storeKind, message);
    this.name = 'SqliteBlockedError';
  }
}

/** A hippo.db open in a folder whose marker names the store that holds its memories, from the CLI as from a request. */
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
