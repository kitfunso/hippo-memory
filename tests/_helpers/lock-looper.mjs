// Takes, holds about 2 ms and releases one file lock in a loop, logging each enter, exit and unusable result.
import { appendFileSync } from 'node:fs';
import { takeFileLock } from '../../dist/host/file-lock.js';

const [lockPath, logPath, durationMs] = process.argv.slice(2);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = Date.now() + Number(durationMs);
while (Date.now() < until) {
  const take = takeFileLock(lockPath);
  if (take.kind === 'unusable') appendFileSync(logPath, `unusable ${process.pid} ${String(take.cause)}\n`);
  if (take.kind === 'taken') {
    appendFileSync(logPath, `enter ${process.pid}\n`);
    pause(2);
    appendFileSync(logPath, `exit ${process.pid}\n`);
    take.lock.release();
  }
  pause(1);
}
