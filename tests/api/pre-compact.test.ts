// PreCompact's store work behind the api: the boundary record, the merged snapshot and the twin-fire skip.
import { describe, expect, it } from 'vitest';
import { preCompact, type PreCompactRun } from '../../src/api/pre-compact.js';
import type { CaptureInput } from '../../src/base/session/capture-contract.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { compactionRows } from '../_helpers/compaction-hooks.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadActiveTaskSnapshot } from '../_helpers/root-forms.js';

const STATE = { task: 'fix the login test', summary: 'read the flaky spec', next_step: 'rerun it' };

function input(sessionId: string): CaptureInput {
  return {
    runtime: 'claude-code',
    event: 'pre-compact',
    manual: false,
    sessionId,
    cwd: null,
    transcriptPath: null,
    trigger: 'auto',
  };
}

interface Seen {
  printed: number;
  derived: number;
  boundary: (string | null)[];
  lines: string[];
}

/** One PreCompact run and what its host steps saw. */
interface Fired {
  run: PreCompactRun;
  seen: Seen;
}

function run(sessionId: string, opts: Pick<PreCompactRun, 'closable' | 'twinFires'>): Fired {
  const seen: Seen = { printed: 0, derived: 0, boundary: [], lines: [] };
  return {
    seen,
    run: {
      ...opts,
      input: input(sessionId),
      printInstruction: () => {
        seen.printed++;
        return 'instruction\n';
      },
      onBoundary: (printed) => seen.boundary.push(printed),
      workingState: () => {
        seen.derived++;
        return STATE;
      },
      log: (line) => seen.lines.push(line),
    },
  };
}

describe('preCompact', () => {
  it('records the boundary, prints once, then saves the snapshot and marks the record with it', async () => {
    const root = makeRoot('api-pre-compact');
    const { run: closable, seen } = run('s1', { closable: true, twinFires: false });
    await preCompact(apiCtx(root), closable);

    expect(seen).toMatchObject({ printed: 1, derived: 1, boundary: ['instruction\n'] });
    expect(seen.lines).toEqual(['snapshot saved']);
    expect(compactionRows(root)).toMatchObject([{ session_id: 's1', snapshot_saved: 1, status: 'started' }]);
    expect(loadActiveTaskSnapshot(root, 'default')).toMatchObject({
      sessionId: 's1',
      source: 'pre-compact',
      task: STATE.task,
      nextStep: STATE.next_step,
    });
  });

  it('skips a twin fire of the same session before any boundary or transcript read', async () => {
    const root = makeRoot('api-pre-compact-twin');
    await preCompact(apiCtx(root), run('s2', { closable: false, twinFires: true }).run);
    const { run: twin, seen } = run('s2', { closable: false, twinFires: true });
    await preCompact(apiCtx(root), twin);

    expect(seen).toMatchObject({ printed: 0, derived: 0, boundary: [] });
    expect(seen.lines).toEqual(['skip: snapshot for session s2 saved under 10 s ago, by the other preCompact entry']);
    expect(compactionRows(root)).toEqual([]);
  });
});
