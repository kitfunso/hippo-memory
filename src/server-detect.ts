import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  started_at: string;
}

const PIDFILE = '.hippo/server.pid';

/**
 * Read .hippo/server.pid and return the embedded ServerInfo if the recorded
 * pid is still alive. Returns null on missing, malformed, or stale pidfiles,
 * and best-effort unlinks the file in the latter two cases.
 */
export function detectServer(hippoRoot: string): ServerInfo | null {
  const path = join(hippoRoot, PIDFILE);
  if (!existsSync(path)) return null;

  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }

  // Probe the process. Sending signal 0 throws if the pid is dead or owned
  // by another user we cannot signal. Either way, treat as stale.
  // Node's process.kill(pid, 0) is implemented on Windows via OpenProcess +
  // GetExitCodeProcess, so this works cross-platform for the dead-pid case.
  try {
    process.kill(info.pid, 0);
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
  return info;
}

/**
 * Atomically write the pidfile. Writes to a process-scoped temp file then
 * renames into place, which is atomic on POSIX and on NTFS via MoveFileEx.
 */
export function writePidfile(hippoRoot: string, opts: { port: number; url: string }): void {
  const path = join(hippoRoot, PIDFILE);
  const tmp = `${path}.tmp.${process.pid}`;
  const info: ServerInfo = {
    pid: process.pid,
    port: opts.port,
    url: opts.url,
    started_at: new Date().toISOString(),
  };
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, path);
}

/**
 * Best-effort pidfile removal. Silent on ENOENT or any other error so the
 * caller can use this in shutdown paths without fear of throwing.
 */
export function removePidfile(hippoRoot: string): void {
  const path = join(hippoRoot, PIDFILE);
  try { unlinkSync(path); } catch {}
}
