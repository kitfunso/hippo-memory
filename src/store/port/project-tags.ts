// The project names of a store, read and rewritten on one handle; hippo.db's own, since a rewrite backs the store up
// and fixes its mirror files.
import type { ProjectTagScope, ProjectTagStore } from '../project-tags.js';

export interface ProjectTags {
  /** Runs `fn` on the tenant's project-tag rows and writes, on a handle opened for this call and closed after. */
  on<T>(scope: ProjectTagScope, fn: (store: ProjectTagStore) => T): T;
}
