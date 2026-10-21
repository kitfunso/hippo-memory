// The root entry's learning loop: lessons from errors, the share score and the global store.
export { captureError, extractLessons, partitionLessons } from '../domain/learn/autolearn.js';
export { getGlobalRoot } from '../domain/sharing/global-store.js';
export { transferScore } from '../domain/sharing/share.js';
