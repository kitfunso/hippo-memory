// Best-effort browser launch for CLI verbs that write a file.
import { spawn } from 'child_process';
import { errorMessage, log } from '../util/log.js';

/** The part of a child process the launch reads. */
interface Launched {
  on(event: 'error', listener: (err: Error) => void): void;
  unref(): void;
}
type Launcher = (cmd: string, args: string[], opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean }) => Launched;

/** `launch` is the process starter; tests hand in a stand-in. */
export function openInBrowser(out: string, launch: Launcher = spawn): void {
  // Best-effort browser launch; never fail the command if it doesn't work.
  try {
    const [cmd, cmdArgs]: [string, string[]] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', out]]
        : process.platform === 'darwin'
          ? ['open', [out]]
          : ['xdg-open', [out]];
    const child = launch(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    // A missing launcher (e.g. xdg-open absent) emits 'error' asynchronously; unhandled, it would throw.
    child.on('error', (err) => {
      log.warn(`graph view: could not open the browser: ${errorMessage(err)}`);
      process.exitCode = 1;
    });
    child.unref();
  } catch (err) {
    // The file is written and its path printed above, so a browser that will not start costs nothing.
    log.debug(`browser not opened: ${errorMessage(err)}`);
  }
}
