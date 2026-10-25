// The session-end worker owns its process, so it, not the api, writes the held re-read lines when a step ends the
// process before the run writes them.
import { describe, expect, it } from 'vitest';
import { heldLog } from '../../src/api/session-end.js';
import { flushingOnExit } from '../../src/surface/cli/hook-runtime.js';

const LINE = 'skip re-read count: cannot read the transcript';

describe('flushingOnExit', () => {
  it('writes the held lines when the process ends mid-run, and leaves no exit listener behind', async () => {
    const written: string[] = [];
    const held = heldLog((line) => written.push(line));
    const before = new Set(process.listeners('exit'));
    let atExit: readonly string[] = [];

    await flushingOnExit(held, async () => {
      held.hold([LINE]);
      // Only the listeners this run added fire, as a real exit would fire them.
      for (const listener of process.listeners('exit')) if (!before.has(listener)) listener(0);
      atExit = [...written];
    });

    expect(atExit).toEqual([LINE]);
    expect(new Set(process.listeners('exit'))).toEqual(before);
  });
});
