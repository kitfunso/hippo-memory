// What `hippo dashboard` prints at start, and the one line a port that will not open gets.
import * as fs from 'fs';
import * as path from 'path';
import { printError } from './output.js';

const DASHBOARD_URL_FILE = 'dashboard.url';

/** Writes the URL with its token to an owner-only file and prints where it is; a terminal, like a captured log, never
 * shows the token, since anyone who reads it can read every memory. */
export function printDashboardBanner(hippoRoot: string, port: number, token: string, staticRoot: string | null): void {
  const file = path.join(hippoRoot, DASHBOARD_URL_FILE);
  // Created fresh, so its mode holds even where an older file had a wider one.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `http://localhost:${port}/?token=${token}\n`, { flag: 'wx', mode: 0o600 });
  // The banner is the command's printed result, so it stays on stdout.
  console.log(`Hippo Dashboard running at http://localhost:${port}/ (open the URL with its token from ${file})`);
  if (staticRoot !== null) console.log(`Serving React UI from ${staticRoot}`);
  console.log('Press Ctrl+C to stop.');
}

/** A port that will not open is the user's to fix, so it gets one plain line and a failure exit code, not a stack. */
export function reportListenFailure(port: number, err: Error): void {
  const inUse = 'code' in err && err.code === 'EADDRINUSE';
  printError(
    inUse
      ? `hippo dashboard: port ${port} is already in use. ` +
          'Stop the program that holds it, or choose another port with --port <number>.'
      : `hippo dashboard: could not listen on port ${port}: ${err.message}. Choose another port with --port <number>.`,
  );
  process.exitCode = 1;
}
