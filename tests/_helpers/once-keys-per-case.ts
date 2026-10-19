// A once-only log line is spent for the rest of the process, and a test file is one process; a case that asserts one
// starts with none spent, as a fresh process does.
import { vi } from 'vitest';
import { log } from '../../src/util/log.js';

/** Spies log.once so the calling case keeps its own spent keys; restoreAllMocks ends it. */
export function onceKeysPerCase(): void {
  const seen = new Set<string>();
  vi.spyOn(log, 'once').mockImplementation((key, level, message, fields) => {
    if (seen.has(key)) return;
    seen.add(key);
    log[level](message, fields);
  });
}
