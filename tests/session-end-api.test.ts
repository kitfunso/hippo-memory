// sessionEndWork runs from the api with no CLI: real store, host steps passed in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { cliApiContext } from '../src/cli/api-context.js';
import { sessionEndWork, type SessionEndWork } from '../src/api/session-end.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { makeRoot } from './_helpers/make-root.js';
import { loadActiveTaskSnapshot } from './_helpers/root-forms.js';

const TENANT = 'default';
let root: string;
let lines: string[];
let steps: string[];

beforeEach(() => {
  root = makeRoot('session-end-api');
  lines = [];
  steps = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function work(over: Partial<SessionEndWork<string>> = {}): SessionEndWork<string> {
  return {
    mode: 'full',
    hippoRoot: root,
    tenantId: TENANT,
    sessionId: 's1',
    transcriptPath: undefined,
    contextFor: (hippoRoot) => cliApiContext(hippoRoot, TENANT),
    storeRoot: () => root,
    log: (line) => { lines.push(line); },
    sleep: async () => { steps.push('sleep'); },
    readScan: () => { steps.push('scan'); return 'scan'; },
    capture: (_store, scan) => { steps.push(`capture:${scan}`); },
    digest: (scan) => { steps.push(`digest:${scan}`); },
    workingState: () => null,
    evidence: () => ({}),
    ...over,
  };
}

describe('sessionEndWork', () => {
  it('runs the steps in order and closes the session snapshot', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    await sessionEndWork(work());
    expect(steps).toEqual(['sleep', 'scan', 'capture:scan', 'digest:scan']);
    expect(loadActiveTaskSnapshot(root, TENANT)).toBeNull();
    expect(lines.some((l) => l.includes('closed 1 active snapshot(s) for session s1'))).toBe(true);
  });

  it('a turn close leaves the snapshot open', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    await sessionEndWork(work({ mode: 'turn' }));
    expect(loadActiveTaskSnapshot(root, TENANT)?.session_id).toBe('s1');
    expect(lines).toContain('skip snapshot close: turn mode');
  });

  it('skips every step when no store exists', async () => {
    await sessionEndWork(work({ storeRoot: () => null }));
    expect(steps).toEqual([]);
    expect(lines).toContain('skip: no hippo store for this folder or globally');
  });

  // A worker process runs many sessions, so a listener per call would pile up until the process exits.
  it('leaves no exit listener behind once the re-read lines are logged', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    const before = process.listenerCount('exit');
    const transcriptPath = `${root}-missing.jsonl`;
    await sessionEndWork(work({ transcriptPath }));
    await sessionEndWork(work({ transcriptPath, storeRoot: () => null }));
    expect(process.listenerCount('exit')).toBe(before);
    const reread = lines.filter((l) => l.startsWith('skip re-read count: cannot read the transcript'));
    expect(reread).toHaveLength(2);
    const closed = lines.findIndex((l) => l.includes('closed 1 active snapshot(s) for session s1'));
    expect(closed).toBeGreaterThan(lines.indexOf(reread[0]!));
  });

  it('still logs the re-read lines at exit when sleep throws before they are written', async () => {
    const before = process.listeners('exit');
    await expect(sessionEndWork(work({ transcriptPath: `${root}-missing.jsonl`, sleep: async () => { throw new Error('sleep failed'); } })))
      .rejects.toThrow('sleep failed');
    const added = process.listeners('exit').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    try {
      expect(lines.some((l) => l.startsWith('skip re-read count'))).toBe(false);
      added[0]!(0);
      expect(lines.some((l) => l.startsWith('skip re-read count'))).toBe(true);
    } finally {
      process.off('exit', added[0]!);
    }
  });
});
