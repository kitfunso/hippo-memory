// Leaf module: path canonicalisation shared by project identity and the importers.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage, log, errorFields } from '../base/util/log.js';

/** True for a regular file, or a symlink to one; false when the path is missing. */
export function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
}

/** Dereferences symlinks and junctions and normalizes case on Windows; falls back to
 * path.resolve when the path does not exist yet. */
export function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    log.debug(`realpath fell back to resolve for ${p}: ${errorMessage(err)}`, errorFields(err));
    return path.resolve(p);
  }
}

/** realpathOrResolve of the nearest folder of `p` that exists, with the rest of `p` added, so a
 * path names one place before and after its folders are made. */
export function realpathOfNearest(p: string): string {
  const missing: string[] = [];
  let at = path.resolve(p);
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    missing.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(realpathOrResolve(at), ...missing);
}
