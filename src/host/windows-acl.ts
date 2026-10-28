// Node's chmod cannot set an owner-only mode on Windows, so the system's icacls does it.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { errorFields, log } from '../base/util/log.js';

const ICACLS_TIMEOUT_MS = 10_000;

/** Removes every inherited grant from `file` and leaves the current user as its only holder; a
 * refusal logs a warn, since the file stays as private as its folder. */
export function restrictToCurrentUser(file: string): void {
  const user = userInfo().username;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: ICACLS_TIMEOUT_MS,
    });
  } catch (err) {
    log.warn(
      `could not limit ${file} to ${user}; run icacls "${file}" /inheritance:r /grant:r "${user}:F"`,
      errorFields(err),
    );
  }
}
