// One way to replace a file a user or another program depends on: write a temp file beside it, then rename over it.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage, log } from './log.js';

const RENAME_RETRY_MS = 1000;
const WINDOWS_RENAME_REFUSALS = ['EPERM', 'EACCES', 'EBUSY'];
// A rename can be refused where an in-place write still works (a bind-mounted file, a read-only folder), so these fall back to one.
const REPLACE_REFUSALS = ['EBUSY', 'EXDEV', 'EACCES', 'EPERM'];
// Matches the usual SYMLOOP_MAX, so a link cycle ends in an error instead of a hang.
const MAX_LINK_HOPS = 40;

function errnoCode(err: Error): string {
  return 'code' in err ? String(err.code) : '';
}

/** Windows refuses a rename onto a file another program has open, usually for a moment, so a refusal is retried before it is reported. */
function renameOnto(tmp: string, target: string): void {
  const deadline = Date.now() + RENAME_RETRY_MS;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  for (let pause = 10; ; pause = Math.min(pause * 2, 200)) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      const transient = process.platform === 'win32' && err instanceof Error && WINDOWS_RENAME_REFUSALS.includes(errnoCode(err));
      const left = deadline - Date.now();
      if (!transient || left <= 0) throw err;
      Atomics.wait(idle, 0, 0, Math.min(pause, left));
    }
  }
}

/** Where a write to `file` lands: through any symlink, a dangling one included, so a dotfile manager's link survives. */
function writeTarget(file: string): string {
  let target = file;
  for (let hop = 0; hop < MAX_LINK_HOPS && fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(); hop++) {
    target = path.resolve(path.dirname(target), fs.readlinkSync(target));
  }
  return fs.existsSync(target) ? fs.realpathSync(target) : target;
}

/** Gives the replacement the old file's exact mode (umask trims the create mode) and, for root, its owner. */
function keepAccess(tmp: string, old: fs.Stats): void {
  fs.chmodSync(tmp, old.mode & 0o777);
  if (process.getuid?.() === 0) fs.chownSync(tmp, old.uid, old.gid);
}

/** Cleanup must not hide the failure that made it necessary, so a cleanup error is logged and the first error stays the one thrown. */
function removeTemp(tmp: string): void {
  try {
    fs.rmSync(tmp, { force: true });
  } catch (err) {
    log.warn(`could not remove the temporary file ${tmp}: ${errorMessage(err)}`);
  }
}

function replaceViaTemp(target: string, text: string, old: fs.Stats | undefined): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: (old?.mode ?? 0o666) & 0o777 });
    if (old) keepAccess(tmp, old);
    renameOnto(tmp, target);
  } catch (err) {
    removeTemp(tmp);
    throw err;
  }
}

/** The pre-rename write: it truncates first, so it is only the fallback, but it needs just a writable file and keeps hard links together. */
function writeInPlace(target: string, text: string): void {
  try {
    fs.writeFileSync(target, text, 'utf8');
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const reason = errnoCode(err) === 'EBUSY'
      ? 'is in use by another program, so hippo could not replace it; close that program and run the command again'
      : `could not be replaced (${errnoCode(err) || err.message})`;
    throw new Error(`${target} ${reason}`, { cause: err });
  }
}

/** Writes `text` to `file` so a reader sees the old content or the new, never a truncated file: a crash mid-write leaves the old one. */
export function writeFileAtomic(file: string, text: string): void {
  const target = writeTarget(file);
  const old = fs.statSync(target, { throwIfNoEntry: false });
  if (old === undefined) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } else {
    // A rename replaces a read-only file that the in-place write refused, and Windows would retry that refusal for a second.
    fs.accessSync(target, fs.constants.W_OK);
  }
  if (old !== undefined && old.nlink > 1) {
    // A rename gives the file a new inode, which would leave the other hard links on the old content.
    writeInPlace(target, text);
    return;
  }
  try {
    replaceViaTemp(target, text, old);
  } catch (err) {
    if (!(err instanceof Error) || !REPLACE_REFUSALS.includes(errnoCode(err))) throw err;
    writeInPlace(target, text);
  }
}
