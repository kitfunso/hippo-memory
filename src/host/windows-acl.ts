// Node's chmod cannot set an owner-only mode on Windows, so the system's icacls does it.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import * as path from 'node:path';
import { errorFields, log } from '../base/util/log.js';

const ICACLS_TIMEOUT_MS = 10_000;

/** Removes every inherited grant from a file this process just created, which has no explicit
 * grants, and leaves the current user as its only holder; `systemRoot` is the SystemRoot folder. A
 * refusal logs a warn, since the file stays as private as its folder. */
export function restrictToCurrentUser(file: string, systemRoot: string | undefined): void {
  const user = userInfo().username;
  const fix = `run icacls "${file}" /inheritance:r /grant:r "${user}:F"`;
  // By full path: Windows looks for a bare name in the working folder first, which may be a repo.
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    log.warn(`could not limit ${file} to ${user}: SystemRoot is not an absolute path; ${fix}`);
    return;
  }
  try {
    execFileSync(
      path.win32.join(systemRoot, 'System32', 'icacls.exe'),
      [file, '/inheritance:r', '/grant:r', `${user}:F`],
      {
        stdio: 'pipe',
        windowsHide: true,
        timeout: ICACLS_TIMEOUT_MS,
      },
    );
  } catch (err) {
    log.warn(`could not limit ${file} to ${user}; ${fix}`, errorFields(err));
  }
}
