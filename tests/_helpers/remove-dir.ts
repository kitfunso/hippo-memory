// Windows refuses to delete a store whose handle is open for a short while after its close, so removal retries.
import { rmSync } from 'node:fs';

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
