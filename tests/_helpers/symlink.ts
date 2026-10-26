import * as fs from 'node:fs';

/** Creates a link and returns true; false when this machine lacks the privilege, unless CI set HIPPO_REQUIRE_SYMLINKS=1, which makes that a failure. */
export function trySymlink(target: string, link: string, type?: 'junction' | 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    // SAFETY: fs.symlinkSync throws only errno exceptions.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM' || process.env.HIPPO_REQUIRE_SYMLINKS === '1') throw err;
    return false;
  }
}
