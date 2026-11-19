// Windows refuses to delete a store whose handle is open for a short while after its close, so removal retries.
import { rmSync } from 'node:fs';

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** For a folder a detached worker may still hold as its working folder: rmSync gives up at once on that EPERM, so this waits up to 10 s. */
export function removeDirOfWorker(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 50) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
