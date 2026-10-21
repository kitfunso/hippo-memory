// A once-only log line is spent for the rest of the process, and a test file is one process; a case that asserts one
// starts with none spent, as a fresh process does.
import { vi } from 'vitest';
import { log } from '../../src/base/util/log.js';

/** Spies log.once and log.warnThenSample so the calling case keeps its own spent keys; restoreAllMocks ends it. */
export function onceKeysPerCase(): void {
  const seen = new Set<string>();
  vi.spyOn(log, 'once').mockImplementation((key, level, message, fields) => {
    if (seen.has(key)) return;
    seen.add(key);
    log[level](message, fields);
  });
  const repeats = new Map<string, number>();
  vi.spyOn(log, 'warnThenSample').mockImplementation((key, message, fields) => {
    const count = repeats.get(key);
    repeats.set(key, (count ?? -1) + 1);
    if (count === undefined) log.warn(message, fields);
    else if ((count + 1) % 100 === 0) log.warn(`${message} (${count + 1} more since the first warning)`, fields);
    else log.debug(message, fields);
  });
}
