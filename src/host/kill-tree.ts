// Ends a child and everything it started. A shell or cmd.exe between us and the program would
// otherwise leave the program running after a plain kill.
import { execFile } from 'node:child_process';
import { errorCode, errorFields, errorMessage, log } from '../base/util/log.js';
import { spawnArgv } from './spawn-argv.js';

/** Starts taskkill; a test passes a stand-in. */
type SpawnKiller = typeof spawnArgv;

const TASKKILL_MS = 10_000;
const PS_MS = 2_000;
const MAX_ROUNDS = 5;
let warnedNoPs = false;

/** Sends `signal`; a process already gone (ESRCH) or not ours (EPERM) counts as ended. */
function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = errorCode(err);
    if (code !== 'ESRCH' && code !== 'EPERM') {
      log.warn(`kill-tree: ${signal} to ${pid} failed: ${errorMessage(err)}`, errorFields(err));
    }
  }
}

/** Parent of each process, from one `ps` snapshot. Rejects when ps cannot run. */
function parentsByPid(): Promise<Map<number, number>> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,ppid='],
      { timeout: PS_MS, windowsHide: true },
      (err, stdout) => {
        if (err !== null) {
          reject(err);
          return;
        }
        const parents = new Map<number, number>();
        for (const line of stdout.split('\n')) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
        }
        resolve(parents);
      },
    );
  });
}

/** Every descendant of `root` in the snapshot, nearest first. */
function descendants(root: number, parents: ReadonlyMap<number, number>): number[] {
  const found: number[] = [];
  const queue = [root];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const [pid, ppid] of parents) {
      if (ppid === at && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

/** Stops the child and each new descendant until a snapshot shows no new one, so none can start
 * another while the tree is walked; then kills them, deepest first. */
async function killPosixTree(pid: number): Promise<void> {
  send(pid, 'SIGSTOP');
  const stopped: number[] = [];
  try {
    let settled = false;
    for (let round = 0; round < MAX_ROUNDS && !settled; round++) {
      const fresh = descendants(pid, await parentsByPid()).filter((p) => !stopped.includes(p));
      settled = fresh.length === 0;
      for (const p of fresh) send(p, 'SIGSTOP');
      stopped.push(...fresh);
    }
    if (!settled) {
      log.warn(`kill-tree: ${pid} still had new descendants after ${MAX_ROUNDS} rounds`);
    }
  } catch (err) {
    if (!warnedNoPs) {
      warnedNoPs = true;
      log.warn(
        `kill-tree: ps is unavailable, so only the child is killed: ${errorMessage(err)}`,
        errorFields(err),
      );
    }
  }
  for (const p of stopped.reverse()) send(p, 'SIGKILL');
  send(pid, 'SIGKILL');
}

/** taskkill /T walks the tree itself. */
function killWindowsTree(pid: number, spawnKiller: SpawnKiller): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    let killer: ReturnType<SpawnKiller>;
    try {
      killer = spawnKiller(['taskkill', '/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      log.warn(`kill-tree: taskkill did not start: ${errorMessage(err)}`, errorFields(err));
      send(pid, 'SIGKILL');
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      log.warn(`kill-tree: taskkill for ${pid} did not finish in ${TASKKILL_MS} ms, stopped it`);
      killer.kill();
      finish();
    }, TASKKILL_MS);
    killer.on('error', (err: Error) => {
      log.warn(`kill-tree: taskkill did not start: ${err.message}`, errorFields(err));
      send(pid, 'SIGKILL');
      finish();
    });
    killer.on('close', (code: number | null) => {
      // 128 is "no such process": the tree was already gone.
      if (code !== 0 && code !== 128) {
        log.warn(`kill-tree: taskkill for ${pid} exited with ${code ?? 'a signal'}`);
      }
      finish();
    });
  });
}

/** Kills `pid` and its descendants. Never rejects: a failure is logged. A grandchild whose parent
 * already exited is not in the tree and is left running. */
export async function killTree(pid: number, spawnKiller: SpawnKiller = spawnArgv): Promise<void> {
  try {
    await (process.platform === 'win32' ? killWindowsTree(pid, spawnKiller) : killPosixTree(pid));
  } catch (err) {
    log.warn(`kill-tree: ${pid} not fully killed: ${errorMessage(err)}`, errorFields(err));
  }
}
