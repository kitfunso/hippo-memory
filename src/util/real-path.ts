// Leaf module: path canonicalisation shared by project identity and the importers.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage, log } from '../log.js';

/** Dereferences symlinks and junctions and normalises case on Windows; falls back to path.resolve when the path does not exist yet. */
export function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    log.debug(`realpath fell back to resolve for ${p}: ${errorMessage(err)}`);
    return path.resolve(p);
  }
}
