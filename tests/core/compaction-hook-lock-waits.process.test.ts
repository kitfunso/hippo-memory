// The compaction hooks on a locked store; the waits come from the spawned hook itself, since a stopwatch around the child also times the runner.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPACTION_DB_WAIT_MS } from '../../src/core/compaction-timing.js';
import { closeHippoDb, HOOK_DB_WAIT_MS, openHippoDb } from '../../src/db/index.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  compactionMemories,
  compactionRows,
  oneLine,
  postCompactPayload,
  removeScratch,
  runHippo as runHippoIn,
  scratch,
  summaryWith,
  type Scratch,
} from '../_helpers/compaction-hooks.js';
import { lockWaitAskedMs, tracingLockWaits } from '../_helpers/lock-waits.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';

// The instruction Claude Code hands the summarizer; pinned word for word.
const INSTRUCTION =
  "In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', each lesson learned, decision made (with its reason) and correction the user gave in this session that should outlive it. Write each as a standalone sentence that names its subject. Leave out anything an earlier summary already listed under 'Memories for hippo', and anything this session already saved with `hippo remember`. Write '- none' if nothing new remains.";
const ITEMS = [
  'The billing service uses pnpm, so npm install is never run there.',
  'The search service cache must be flushed after every deploy.',
];

let s: Scratch;

beforeEach(() => {
  s = scratch();
});
afterEach(() => removeScratch(s));

describe('pre-compact on a locked store', () => {
  it('exits 0 and still asks for memories when the store is locked', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    const logFile = path.join(s.dir, 'logs', 'pre-compact.log');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            'Fix the flaky login test. Never run npm install in the billing service; the lockfile is pnpm-lock.yaml.',
        },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the login test now.' }] },
        }) +
        '\n',
    );
    initTestStore(s.hippoRoot);
    const db = openHippoDb(s.hippoRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const waits = path.join(s.dir, 'lock-waits');
      s.env = tracingLockWaits(s.env, waits);
      const payload = JSON.stringify({
        transcript_path: transcript,
        cwd: s.proj,
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        session_id: 's1',
      });
      const result = hippoRun(['pre-compact', '--log-file', logFile], { cwd: s.proj, env: s.env, input: payload });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${INSTRUCTION}\n`);
      // One wait for the token-ledger row and one for the record, then none: far inside the 30 s Claude Code gives PreCompact.
      expect(lockWaitAskedMs(waits, result.pid)).toBe(HOOK_DB_WAIT_MS + COMPACTION_DB_WAIT_MS);
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
  });
});

describe('post-compact on a locked store', () => {
  it('a locked store makes the hook spool inside its budget, and sleep imports the spool', async () => {
    initTestStore(s.hippoRoot);
    const db = openHippoDb(s.hippoRoot);
    const waits = path.join(s.dir, 'lock-waits');
    try {
      db.exec('BEGIN IMMEDIATE');
      const hook = hippoRun(['post-compact'], {
        cwd: s.proj,
        env: tracingLockWaits(s.env, waits),
        input: postCompactPayload('s1', s.proj, summaryWith(ITEMS)),
      });
      expect(hook.status).toBe(0);
      expect(oneLine(hook.stdout)).toBe('Hippo will finish saving this compaction at the next sleep.');
      // One wait, then the spool: a small part of the 10 s Claude Code gives PostCompact.
      expect(lockWaitAskedMs(waits, hook.pid)).toBe(COMPACTION_DB_WAIT_MS);
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }

    const spool = path.join(s.hippoRoot, 'compactions-spool');
    expect(fs.readdirSync(spool).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);

    expect((await runHippoIn(['sleep', '--no-learn', '--no-share'], s.proj, s.env)).status).toBe(0);
    expect(fs.readdirSync(spool)).toEqual([]);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  });
});
