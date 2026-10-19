// The operator's global stores a server opens beside its own; a root that serves hippo.db builds them.
import type { StoreWith } from '../port.js';

/** The operator's global stores a server opens beside its own, closed with it. */
export interface GlobalStores {
  readonly open: (root: string) => StoreWith<'localFiles'>;
  readonly close: () => Promise<void>;
}
