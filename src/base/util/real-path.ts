// Leaf module: path canonicalisation shared by project identity and the importers.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage, log, errorFields } from './log.js';

/** True for a regular file, or a symlink to one; false when the path is missing. */
export function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
}

/** Dereferences symlinks and junctions and normalizes case on Windows; falls back to path.resolve when the path does
 * not exist yet. */
export function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    log.debug(`realpath fell back to resolve for ${p}: ${errorMessage(err)}`, errorFields(err));
    return path.resolve(p);
  }
}
