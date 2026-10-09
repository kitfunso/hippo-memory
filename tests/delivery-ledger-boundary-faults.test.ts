// Twin fires, decision invariance and fail-soft for the two boundary rows of the delivery ledger.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cmdPreCompact } from '../src/capture/compact.js';
import { PRE_COMPACT_INSTRUCTION } from '../src/capture/compaction-record.js';
import { loadActiveTaskSnapshot } from '../src/store/sessions.js';
import { normaliseHookPayload } from '../src/cli/stdin.js';
import type { DeliveryFault } from '../src/store/delivery-recorder.js';
import { copilotEventsJsonl, copilotPayload, writeCopilotSessionLog } from './_helpers/copilot-hooks.js';
import {
  SNAPSHOT_TASK, dispose, eventCount, events, eventsN, hippo, hippoAsync, ledgerLines, preCompactPayload, project, resumePayload,
  tableRows, withDb, writeTranscript, type Project,
} from './_helpers/delivery-boundary.js';

const T0 = '2099-01-01T00:00:00.000Z';
const T0_PLUS_3S = '2099-01-01T00:00:03.000Z';

let p: Project;

beforeEach(() => {
  p = project();
});

afterEach(() => {
  dispose(p);
});

const HOOKS = ['pre-compact', 'compact-resume'];
const payloadFor = (hook: string, session: string): string => (hook === 'pre-compact' ? preCompactPayload(session) : resumePayload(session));

describe('B8: a hook registered twice does not number a compaction twice', () => {
  it.each(HOOKS)('%s: two fires at one instant make one numbered row and one duplicate; 3 s later is number 2', (hook) => {
    const input = payloadFor(hook, 'b8');
    for (const now of [T0, T0, T0_PLUS_3S]) {
      expect(hippo(p, [hook], { input, env: { HIPPO_FAKE_NOW: now } }).status).toBe(0);
    }
    const [first, twin, later] = eventsN(p, 'b8', 3);
    expect([first.turn_seq, twin.turn_seq, twin.duplicate_of, later.turn_seq, later.duplicate_of]).toEqual([1, null, first.id, 2, null]);
  });

  it.each(HOOKS)('%s: two processes started together leave one numbered row and no lost count', async (hook) => {
    const run = (): ReturnType<typeof hippoAsync> => hippoAsync(p, [hook], { input: payloadFor(hook, 'b8-race'), env: { HIPPO_FAKE_NOW: T0 } });
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.status)).toEqual([0, 0]);
    const rows = events(p, 'b8-race');
    const dropped = results.flatMap((r) => ledgerLines(r.stderr));
    expect(rows.filter((e) => e.turn_seq !== null)).toHaveLength(1);
    expect(rows.length + dropped.length).toBe(2);
  });

  it('copilot: preCompact then PreCompact for one compaction leave exactly one row', () => {
    const transcript = writeCopilotSessionLog(path.join(p.dir, '.copilot'), 'copilot-sess-1', copilotEventsJsonl());
    const camel = copilotPayload('preCompact', p.cwd, transcript);
    // SAFETY: the fixture is a JSON object; the second fire is the same compaction under the snake_case event name.
    const snake = JSON.stringify({ ...JSON.parse(copilotPayload('PreCompact', p.cwd, transcript)), session_id: 'copilot-sess-1' });
    for (const input of [camel, snake]) expect(hippo(p, ['pre-compact', '--runtime', 'copilot'], { input }).status).toBe(0);
    expect(events(p, 'copilot-sess-1')).toHaveLength(1);
  });
});

/** The snapshot block prints its save time, which differs between any two runs. */
const maskTimes = (text: string): string => text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>');

interface Observed {
  status: Array<number | null>;
  stdout: string[];
  snapshot: Array<string | null>;
  compactions: Array<{ [column: string]: string | number | null }>;
  tokens: Array<{ [column: string]: string | number | null }>;
}

/** Pre-compact over a real transcript, then compact-resume over the snapshot it saved. */
function scenario(proj: Project, fault?: DeliveryFault): Observed {
  const pre = hippo(proj, ['pre-compact'], { input: preCompactPayload('inv', { transcript_path: writeTranscript(proj), cwd: proj.cwd }), fault });
  const resume = hippo(proj, ['compact-resume'], { input: resumePayload('inv'), fault });
  const snap = loadActiveTaskSnapshot(proj.hippoRoot, 'default');
  return {
    status: [pre.status, resume.status],
    stdout: [pre.stdout, maskTimes(resume.stdout)],
    snapshot: [snap?.task ?? null, snap?.summary ?? null, snap?.next_step ?? null, snap?.session_id ?? null, snap?.source ?? null],
    compactions: tableRows(proj, 'SELECT session_id, compact_trigger, snapshot_saved, items_written, status FROM compactions ORDER BY started_at, id'),
    tokens: tableRows(proj, 'SELECT surface, event, items, tokens, session_id FROM token_ledger ORDER BY id'),
  };
}

function renameLedgerTable(proj: Project): void {
  withDb(proj, (db) => db.exec('ALTER TABLE delivery_events RENAME TO delivery_events_gone'));
}

describe('B9 and B10: the ledger never changes either hook', () => {
  it('B9: ledger on and off print the same bytes and save the same rows; on adds exactly the two boundary rows', () => {
    const off = project({ ledger: false });
    try {
      const baseline = scenario(off);
      expect(baseline.stdout[0]).not.toBe('');
      expect(baseline.stdout[1]).toContain(SNAPSHOT_TASK);
      const on = scenario(p);
      expect(on).toEqual(baseline);
      expect(events(p, 'inv').map((e) => e.event_type)).toEqual(['pre-compact', 'compact-resume']);
      expect(eventCount(off)).toBe(0);
    } finally {
      dispose(off);
    }
  });

  it.each<[string, DeliveryFault | 'renamed-table']>([
    ['observe', 'observe'],
    ['build', 'build'],
    ['flush', 'flush'],
    ['a renamed delivery_events table', 'renamed-table'],
  ])('B10: with %s both hooks print the same bytes and save the same rows, with one ledger line each', (_label, kind) => {
    const off = project({ ledger: false });
    try {
      const baseline = scenario(off);
      if (kind === 'renamed-table') renameLedgerTable(p);
      const pre = hippo(p, ['pre-compact'], { input: preCompactPayload('inv', { transcript_path: writeTranscript(p), cwd: p.cwd }), fault: kind === 'renamed-table' ? undefined : kind });
      const resume = hippo(p, ['compact-resume'], { input: resumePayload('inv'), fault: kind === 'renamed-table' ? undefined : kind });
      expect([pre.status, resume.status]).toEqual(baseline.status);
      expect([pre.stdout, maskTimes(resume.stdout)]).toEqual(baseline.stdout);
      expect(ledgerLines(pre.stderr)).toHaveLength(1);
      expect(ledgerLines(resume.stderr)).toHaveLength(1);
      expect(tableRows(p, 'SELECT surface, event, items, tokens, session_id FROM token_ledger ORDER BY id')).toEqual(baseline.tokens);
      expect(tableRows(p, 'SELECT session_id, compact_trigger, snapshot_saved, items_written, status FROM compactions ORDER BY started_at, id')).toEqual(baseline.compactions);
      expect(loadActiveTaskSnapshot(p.hippoRoot, 'default')?.task).toBe(baseline.snapshot[0]);
    } finally {
      dispose(off);
    }
  });
});

describe('B11 and U1', () => {
  it('B11: no column of a boundary row holds the instruction or the snapshot text', () => {
    scenario(p);
    const cells = tableRows(p, 'SELECT * FROM delivery_events').flatMap((r) => Object.values(r)).filter((v): v is string => typeof v === 'string');
    expect(cells.length).toBeGreaterThan(0);
    const raw = [SNAPSHOT_TASK, PRE_COMPACT_INSTRUCTION.slice(0, 40), 'delivery ledger'];
    expect(cells.filter((c) => raw.some((t) => c.includes(t)))).toEqual([]);
  });

  it('U1: a boundary callback that throws leaves the snapshot saved and is logged', async () => {
    // SAFETY: the stub returns instead of exiting, so the hook's tail runs; `never` only satisfies the exit signature.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const transcript = writeCopilotSessionLog(path.join(p.dir, '.copilot'), 'copilot-sess-1', copilotEventsJsonl());
      const logFile = path.join(p.dir, 'u1.log');
      await cmdPreCompact(p.hippoRoot, {
        stdinText: normaliseHookPayload(copilotPayload('preCompact', p.cwd, transcript)),
        runtime: 'copilot',
        logFile,
        onBoundary: () => { throw new Error('boom'); },
      });
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toContain('boundary callback failed: boom');
      expect(log).toContain('snapshot saved');
      expect(loadActiveTaskSnapshot(p.hippoRoot, 'default')).toMatchObject({ session_id: 'copilot-sess-1', source: 'pre-compact' });
    } finally {
      exit.mockRestore();
    }
  });
});
