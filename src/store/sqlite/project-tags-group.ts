// hippo.db's ProjectTags: each call's tag rows and writes share one handle.
import type { ProjectTags } from '../port/project-tags.js';
import { projectTagStoreOn } from './project-tags.js';
import type { OnHandle } from './open.js';

export function sqliteProjectTags(on: OnHandle): ProjectTags {
  return {
    on: (scope, fn) => on((db, files) => fn(projectTagStoreOn(db, files, scope))),
  };
}
