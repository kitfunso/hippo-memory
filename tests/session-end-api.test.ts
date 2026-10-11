// sessionEndWork runs from the api with no CLI: real store, host steps passed in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, type Context } from '../src/api/index.js';
import { sessionEndWork, type SessionEndWork } from '../src/api/session-end.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { makeRoot } from './_helpers/make-root.js';

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
    contextFor: (hippoRoot): Context => ({ hippoRoot, tenantId: TENANT, actor: adminActor('test') }),
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
    await sessionEndWork(work({ storeRoot: () => `${root}-missing` }));
    expect(steps).toEqual([]);
    expect(lines).toContain('skip: no hippo store for this folder or globally');
  });
});
