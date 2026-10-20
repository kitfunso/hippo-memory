// sessionEndWork runs from the api with no CLI: real store, host steps passed in, store choice and sleep, capture and
// cursor policy decided by the api.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { cliApiContext } from '../../src/cli/api-context.js';
import { sessionEndWork, type SessionEndWork } from '../../src/api/session-end.js';
import type { Context } from '../../src/api/types.js';
import { loadConfig } from '../../src/core/config.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';

const TENANT = 'default';
const PROJECT = 'the-session-project';
let root: string;
let lines: string[];
let steps: string[];

interface Scan {
  readonly turns: readonly string[];
}
type Work = SessionEndWork<string, Scan>;

beforeEach(() => {
  root = makeRoot('session-end-api');
  lines = [];
  steps = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function work(over: Partial<Work> = {}): Work {
  return {
    mode: 'full',
    sessionId: 's1',
    transcriptPath: undefined,
    log: (line) => {
      lines.push(line);
    },
    sleep: async () => {
      steps.push('sleep');
    },
    importAgentNotes: () => {
      steps.push('import');
    },
    readScan: () => {
      steps.push('scan');
      return { turns: ['t1', 't2', 't3'] };
    },
    cursor: {
      after: (_id, _file, turns) => turns.slice(1),
      save: (_id, _file, turns) => {
        steps.push(`cursor:${turns.length}`);
      },
    },
    currentProject: () => PROJECT,
    capture: (into, turns, origin) => {
      steps.push(`capture:${into.hippoRoot === root ? 'own' : 'global'}:${turns?.join(',') ?? 'all'}:${origin ?? '-'}`);
      return true;
    },
    digest: async (scan, key) => {
      steps.push(`digest:${scan === null ? 'none' : scan.turns.length}:${key}`);
    },
    workingState: () => null,
    evidence: () => ({}),
    ...over,
  };
}

/** The folder's Context as if it had no store of its own, reaching `globalRoot` (or no global store when null). */
function withoutOwnStore(globalRoot: string | null): Context {
  const ctx = cliApiContext(root, TENANT);
  const reach = { ...ctx.reach!, hasLocal: false, global: undefined };
  if (globalRoot === null) return { ...ctx, reach };
  const global = { root: globalRoot, store: sqliteStore(globalRoot), config: loadConfig(globalRoot) };
  return { ...ctx, reach: { ...reach, global } };
}

function withAutoSleep(threshold: number): Context {
  const ctx = cliApiContext(root, TENANT);
  return { ...ctx, config: { ...ctx.config, autoSleep: { enabled: true, threshold } } };
}

describe('sessionEndWork', () => {
  it('runs the steps in order and closes the session snapshot', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    await sessionEndWork(cliApiContext(root, TENANT), work({ transcriptPath: `${root}/s1.jsonl` }));
    expect(steps).toEqual(['sleep', 'scan', 'capture:own:t1,t2,t3:-', 'digest:3:s1']);
    expect(loadActiveTaskSnapshot(root, TENANT)).toBeNull();
    expect(lines.some((l) => l.includes('closed 1 active snapshot(s) for session s1'))).toBe(true);
  });

  it('a turn close captures only the turns after the cursor, moves it, and leaves the snapshot open', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    await sessionEndWork(withAutoSleep(1000), work({ mode: 'turn', transcriptPath: `${root}/s1.jsonl` }));
    expect(steps).toEqual(['scan', 'capture:own:t2,t3:-', 'cursor:3', 'digest:3:s1']);
    expect(loadActiveTaskSnapshot(root, TENANT)?.session_id).toBe('s1');
    expect(lines).toContain('skip snapshot close: turn mode');
  });

  it('a turn close sleeps only once the new memories reach the auto-sleep threshold', async () => {
    await sessionEndWork(withAutoSleep(1000), work({ mode: 'turn' }));
    expect(steps).not.toContain('sleep');
    expect(lines).toContain('turn close, session s1: skip sleep, 0 new memories, threshold 1000');
    lines = [];
    steps = [];
    await sessionEndWork(withAutoSleep(0), work({ mode: 'turn' }));
    expect(steps[0]).toBe('sleep');
    expect(lines).toContain('turn close, session s1: ran sleep at 0 new memories (threshold 0)');
  });

  it('a turn close with no new turns captures nothing and keeps the cursor', async () => {
    const cursor = {
      after: () => [],
      save: () => {
        steps.push('cursor');
      },
    };
    await sessionEndWork(withAutoSleep(1000), work({ mode: 'turn', transcriptPath: `${root}/s1.jsonl`, cursor }));
    expect(steps).toEqual(['scan', 'digest:3:s1']);
    expect(lines).toContain('skip capture: no new turns since the last reply');
  });

  it('a folder with no store of its own skips sleep, imports its notes and captures into the global store', async () => {
    const globalRoot = makeRoot('session-end-api-global');
    try {
      saveActiveTaskSnapshot(globalRoot, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
      await sessionEndWork(withoutOwnStore(globalRoot), work({ transcriptPath: `${root}/s1.jsonl` }));
      expect(steps).toEqual(['import', 'scan', `capture:global:t1,t2,t3:${PROJECT}`, 'digest:3:s1']);
      expect(lines).toContain('skip sleep: this folder has no store of its own');
      expect(loadActiveTaskSnapshot(globalRoot, TENANT)).toBeNull();
    } finally {
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });

  it('skips every step when no store exists', async () => {
    await sessionEndWork(withoutOwnStore(null), work());
    expect(steps).toEqual([]);
    expect(lines).toContain('skip: no hippo store for this folder or globally');
  });

  it('captures nothing without a transcript, and keys the digest on the transcript name without a session id', async () => {
    await sessionEndWork(cliApiContext(root, TENANT), work());
    expect(lines).toContain('skip capture: no transcript for this session');
    steps = [];
    await sessionEndWork(cliApiContext(root, TENANT), work({ sessionId: null, transcriptPath: `${root}/abc.jsonl` }));
    expect(steps).toContain('digest:3:abc');
  });

  // A worker process runs many sessions, so a listener per call would pile up until the process exits.
  it('leaves no exit listener behind once the re-read lines are logged', async () => {
    saveActiveTaskSnapshot(root, TENANT, { task: 't', summary: 's', next_step: 'n', session_id: 's1' });
    const before = process.listenerCount('exit');
    const transcriptPath = `${root}-missing.jsonl`;
    await sessionEndWork(cliApiContext(root, TENANT), work({ transcriptPath }));
    await sessionEndWork(withoutOwnStore(null), work({ transcriptPath }));
    expect(process.listenerCount('exit')).toBe(before);
    const reread = lines.filter((l) => l.startsWith('skip re-read count: cannot read the transcript'));
    expect(reread).toHaveLength(2);
    const closed = lines.findIndex((l) => l.includes('closed 1 active snapshot(s) for session s1'));
    expect(closed).toBeGreaterThan(lines.indexOf(reread[0]!));
  });

  it('still logs the re-read lines at exit when sleep throws before they are written', async () => {
    const before = process.listeners('exit');
    const sleep = async (): Promise<void> => {
      throw new Error('sleep failed');
    };
    await expect(
      sessionEndWork(cliApiContext(root, TENANT), work({ transcriptPath: `${root}-missing.jsonl`, sleep })),
    ).rejects.toThrow('sleep failed');
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
