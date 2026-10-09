import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPACTION_DB_WAIT_MS } from '../src/compaction-record.js';
import { closeHippoDb, HOOK_DB_WAIT_MS, openHippoDb } from '../src/db.js';
import { loadActiveTaskSnapshot } from '../src/store/sessions.js';
import {
  compactionRows,
  initProject,
  oneLine,
  postCompactPayload,
  removeScratch,
  runHippo,
  scratch,
  summaryWith,
  type Scratch,
} from './_helpers/compaction-hooks.js';
import { lockWaitAskedMs, tracingLockWaits } from './_helpers/lock-waits.js';

// The instruction Claude Code hands the summariser; pinned word for word.
const INSTRUCTION =
  "In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', each lesson learned, decision made (with its reason) and correction the user gave in this session that should outlive it. Write each as a standalone sentence that names its subject. Leave out anything an earlier summary already listed under 'Memories for hippo', and anything this session already saved with `hippo remember`. Write '- none' if nothing new remains.";

let s: Scratch;
let transcript: string;
let logFile: string;

beforeEach(() => {
  s = scratch();
  transcript = path.join(s.proj, 't.jsonl');
  logFile = path.join(s.dir, 'logs', 'pre-compact.log');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the flaky login test. Never run npm install in the billing service; the lockfile is pnpm-lock.yaml.' } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the login test now.' }] } }) + '\n',
  );
});
afterEach(() => removeScratch(s));

function preCompact(session: string | null, transcriptPath: string = transcript, trigger = 'auto') {
  // JSON.stringify leaves out an undefined session_id.
  const payload = { transcript_path: transcriptPath, cwd: s.proj, hook_event_name: 'PreCompact', trigger, session_id: session ?? undefined };
  return runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, JSON.stringify(payload));
}

describe('hippo pre-compact leaves a record and asks for memories', () => {
  it('inserts a started record and prints the instruction once, on fd 1', () => {
    initProject(s);
    const result = preCompact('s1', transcript, 'manual');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${INSTRUCTION}\n`);

    const [record, ...rest] = compactionRows(s.hippoRoot);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      session_id: 's1',
      status: 'started',
      compact_trigger: 'manual',
      cwd: s.proj,
      transcript_path: transcript,
      origin_project: 'proj',
      snapshot_saved: 1,
      summary: null,
      items_written: 0,
    });
  });

  it('still saves the working-state snapshot, and no report file is left for post-compact', () => {
    initProject(s);
    expect(preCompact('s1').status).toBe(0);
    const snapshot = loadActiveTaskSnapshot(s.hippoRoot, 'default');
    expect(snapshot?.task).toMatch(/npm install/);
    expect(snapshot?.session_id).toBe('s1');
    expect(fs.existsSync(path.join(path.dirname(logFile), 'pre-compact-last.json'))).toBe(false);
  });

  it('records the compaction even when no snapshot is derivable', () => {
    initProject(s);
    const empty = path.join(s.proj, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const result = preCompact('s1', empty);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${INSTRUCTION}\n`);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'started', snapshot_saved: 0 }]);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('prints nothing and writes nothing when no store exists anywhere', () => {
    const result = preCompact('s1');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(fs.existsSync(s.globalRoot)).toBe(false);
  });

  it('prints nothing and writes nothing for a malformed payload', () => {
    initProject(s);
    for (const input of ['not json', '{"session_id":"s1"}', JSON.stringify({ session_id: 's1', transcript_path: null })]) {
      const result = runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('a payload naming no session gets no record and no instruction', () => {
    initProject(s);
    const result = preCompact(null);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('two sessions compacting keep their own records and their own message', () => {
    initProject(s);
    const empty = path.join(s.proj, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    expect(preCompact('s1').status).toBe(0);
    expect(preCompact('s2', empty).status).toBe(0);

    const rows = compactionRows(s.hippoRoot);
    expect(rows.map((r) => [r.session_id, r.snapshot_saved])).toEqual([['s1', 1], ['s2', 0]]);

    const post = (session: string, item: string) =>
      runHippo(['post-compact', '--log-file', logFile], s.proj, s.env, postCompactPayload(session, s.proj, summaryWith([item])));
    expect(oneLine(post('s2', 'Session two keeps its own memories, whatever session one saved.').stdout))
      .toBe('Hippo saved 1 memory from this compaction.');
    expect(oneLine(post('s1', 'Session one restores its own snapshot after compaction.').stdout))
      .toBe('Hippo saved 1 memory from this compaction and restored your task snapshot.');
  });

  it('exits 0 and still asks for memories when the store is locked', () => {
    initProject(s);
    const db = openHippoDb(s.hippoRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const waits = path.join(s.dir, 'lock-waits');
      s.env = tracingLockWaits(s.env, waits);
      const result = preCompact('s1');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${INSTRUCTION}\n`);
      // One wait for the token-ledger row and one for the record, then none: far inside the 30 s Claude Code gives PreCompact.
      expect(lockWaitAskedMs(waits, result.pid)).toBe(HOOK_DB_WAIT_MS + COMPACTION_DB_WAIT_MS);
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
  }, 60_000);
});

describe('the pre-compact diagnostic log', () => {
  const SKIP_LINE = /^\[hippo\] \S+ skip: store not initialized$/;

  const logLines = (): string[] => fs.readFileSync(logFile, 'utf8').split('\n');

  it('adds its line after what a short log already holds', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '[hippo] an earlier line\n');
    expect(preCompact('s1').status).toBe(0);
    const lines = logLines();
    expect(lines[0]).toBe('[hippo] an earlier line');
    expect(lines[1]).toMatch(SKIP_LINE);
    expect(lines.at(-1)).toBe('');
  });

  it('starts the log again once it is past 256 KB, keeping only the new lines', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `${'x'.repeat(256 * 1024 + 1)}\n`);
    expect(preCompact('s1').status).toBe(0);
    // Exactly the new line from byte 0: a write left at the old offset would sit behind a run of NUL bytes.
    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(SKIP_LINE);
    expect(lines[1]).toBe('');
  });

  it('keeps every line whole when another append handle is writing the same log', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const other = fs.openSync(logFile, 'a');
    try {
      fs.writeSync(other, '[hippo] a line from another hook\n');
      expect(preCompact('s1').status).toBe(0);
      fs.writeSync(other, '[hippo] its next line\n');
    } finally {
      fs.closeSync(other);
    }
    const lines = logLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('[hippo] a line from another hook');
    expect(lines[1]).toMatch(SKIP_LINE);
    expect(lines.slice(2)).toEqual(['[hippo] its next line', '']);
  });

  it('creates the log and its folder when neither is there', () => {
    expect(preCompact('s1').status).toBe(0);
    expect(logLines()[0]).toMatch(SKIP_LINE);
  });
});
