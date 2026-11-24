import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** PATH's folders as cmd.exe reads them: a `;` inside quotes stays in its folder and the quotes go. */
export function windowsPathDirs(value) {
  const dirs = [];
  let dir = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) {
      dirs.push(dir);
      dir = '';
    } else dir += ch;
  }
  dirs.push(dir);
  return dirs.filter((entry) => entry.length > 0);
}

function findOnPath(name) {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of windowsPathDirs(process.env.PATH ?? '')) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return null;
}

// cmd.exe expands %NAME% even inside quotes, so each % leaves the quotes as ^%.
function quoteCmdArg(arg) {
  if (/[\r\n]/.test(arg)) {
    throw new Error('a hippo argument holds a line break, which cmd.exe would run as a new command');
  }
  if (arg.length === 0) return '""';
  if (!/[ \t"&()^<>|%!]/.test(arg)) return arg;
  const quoted = arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1');
  return `"${quoted.replace(/%/g, '"^%"')}"`;
}

/** cmd.exe arguments that run the shim with each argument delivered verbatim; the shim path is quoted and %-escaped too. */
export function cmdShimArgs(file, args) {
  const line = [`"${file.replace(/%/g, '"^%"')}"`, ...args.map(quoteCmdArg)].join(' ');
  return ['/d', '/v:off', '/s', '/c', `"${line}"`];
}

/** Starts `hippo <args>`. Throws when Windows finds no hippo on PATH; elsewhere a missing hippo is the child's error event. */
export function spawnHippo(args, stdio) {
  if (process.platform !== 'win32') return spawn('hippo', args, { stdio });
  const file = findOnPath('hippo');
  if (file === null) throw new Error('hippo is not on PATH');
  const ext = extname(file).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return spawn(file, args, { stdio, windowsHide: true });
  // npm installs hippo as a .cmd shim, which Node starts only through cmd.exe.
  return spawn(process.env.ComSpec ?? 'cmd.exe', cmdShimArgs(file, args), {
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}
