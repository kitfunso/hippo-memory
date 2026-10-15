// Starting a command from an argv list with no shell, Windows .cmd and .bat shims included, so no argument is ever
// parsed as shell syntax.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { envPath, envPathExt } from './env.js';

/** Quotes one cmd.exe argument; each `%` leaves the quotes as `^%`, so no %NAME% pair can expand. */
export function quoteCmdArg(arg: string): string {
  // cmd.exe ends the command line at CR or LF, so what follows would run as a new command.
  if (/[\r\n]/.test(arg)) throw new Error('cmd.exe argument contains a CR or LF, which would start a new command');
  if (arg.length === 0) return '""';
  if (!/[ \t"&()^<>|%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
}

/** cmd.exe arguments that run a .cmd or .bat shim with every forwarded argument delivered verbatim. */
export function cmdShimArgs(shimPath: string, forwardArgs: readonly string[]): string[] {
  const command = `"${shimPath}"${forwardArgs.length > 0 ? ` ${forwardArgs.map(quoteCmdArg).join(' ')}` : ''}`;
  // The line is already quoted for cmd.exe, so Node must not quote it again; /s strips the outer pair.
  return ['/d', '/v:off', '/s', '/c', `"${command}"`];
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isFile(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The file `command` names on win32: as given when it has a folder, else the first hit on PATH (never the working
 * folder, where a project file could stand in for a tool), trying each PATHEXT.
 */
function resolveWindowsCommand(command: string): string | null {
  const exts = (envPathExt() ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext.length > 0);
  const dirs = /[\\/]/.test(command) ? [''] : (envPath() ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const base = dir === '' ? command : path.join(dir, command);
    const candidates =
      path.extname(command) === '' ? exts.map((ext) => base + ext) : [base, ...exts.map((ext) => base + ext)];
    const hit = candidates.find(isFile);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Spawns argv[0] with the rest as its arguments and no shell. Node refuses to start a .cmd or .bat without one
 * (CVE-2024-27980),
 *  so on win32 such a shim runs through cmd.exe with every argument quoted for it. */
export function spawnArgv(argv: readonly string[], options: SpawnOptions): ChildProcess {
  const [command, ...args] = argv;
  if (command === undefined || command.length === 0) throw new RangeError('spawnArgv needs a command: argv is empty');
  if (process.platform === 'win32') {
    const resolved = resolveWindowsCommand(command);
    const ext = resolved === null ? '' : path.extname(resolved).toLowerCase();
    if (resolved !== null && (ext === '.cmd' || ext === '.bat')) {
      return spawn('cmd.exe', cmdShimArgs(resolved, args), {
        ...options,
        windowsHide: options.windowsHide ?? true,
        shell: false,
        windowsVerbatimArguments: true,
      });
    }
  }
  return spawn(command, args, { ...options, windowsHide: options.windowsHide ?? true, shell: false });
}
