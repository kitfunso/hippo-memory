// Starts the hippo CLI from PATH with no shell parsing. A copy of src/host/spawn-argv.ts, because this folder ships alone.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

// PATH only, never the working folder, where a file in the user's project could stand in for hippo.
function findOnPath(name) {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
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

/** Starts `hippo <args>`. Throws when Windows finds no hippo on PATH; elsewhere a missing hippo is the child's error event. */
export function spawnHippo(args, stdio) {
  if (process.platform !== 'win32') return spawn('hippo', args, { stdio });
  const file = findOnPath('hippo');
  if (file === null) throw new Error('hippo is not on PATH');
  const ext = extname(file).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return spawn(file, args, { stdio, windowsHide: true });
  // npm installs hippo as a .cmd shim, which Node starts only through cmd.exe.
  const line = `"${file}" ${args.map(quoteCmdArg).join(' ')}`;
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${line}"`], {
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}
