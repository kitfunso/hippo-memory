import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayCompactionsAt } from '../src/compaction-record.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { initStore } from '../src/store.js';
import {
  compactionMemories,
  compactionRows,
  fixturePayload,
  initProject,
  oneLine,
  postCompactPayload,
  removeScratch,
  run,
  runHippo,
  scratch,
  summaryWith,
  type Scratch,
} from './_helpers/compaction-hooks.js';

const MINUTE = 60_000;
const ITEMS = [
  'The billing service uses pnpm, so npm install is never run there.',
  'The search service cache must be flushed after every deploy.',
];

let s: Scratch;
let logs: string[];

beforeEach(() => {
  s = scratch();
  logs = [];
});
afterEach(() => removeScratch(s));

const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();
const log = (message: string): void => {
  logs.push(message);
};

interface Seed {
  id: string;
  status: 'started' | 'summarised';
  startedMinutesAgo: number;
  summarisedMinutesAgo?: number;
  items?: string[];
  transcript?: string;
  session?: string;
}

function seed(root: string, r: Seed): void {
  run(
    root,
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, cwd, transcript_path, started_at, summarised_at, summary, items_json, status)
     VALUES ('default', ?, ?, 'proj', ?, ?, ?, ?, ?, ?, ?)`,
    r.id,
    r.session ?? 's1',
    s.proj,
    r.transcript ?? null,
    ago(r.startedMinutesAgo),
    r.summarisedMinutesAgo === undefined ? null : ago(r.summarisedMinutesAgo),
    r.status === 'summarised' ? 'the summary' : null,
    r.status === 'summarised' ? JSON.stringify(r.items ?? []) : null,
    r.status,
  );
}

function transcriptLine(minutesAgo: number, isSummary: boolean, text: string): string {
  return JSON.stringify({ type: 'user', isCompactSummary: isSummary, timestamp: ago(minutesAgo), message: { role: 'user', content: text } });
}

const CONTINUED = (items: string[]): string =>
  `This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request: fix the login test.\n\nMemories for hippo:\n${items.map((i) => `- ${i}`).join('\n')}`;

describe('replay of records a killed hook left', () => {
  beforeEach(() => initStore(s.hippoRoot));

  it('finishes a record left summarised for over 10 minutes, once', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionMemories(s.hippoRoot).map((r) => r.content).sort()).toEqual([...ITEMS].sort());
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 2 }]);
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
  });

  it('leaves a record that is under 10 minutes old to its own hook', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 5, summarisedMinutesAgo: 1, items: ITEMS });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('summarised');
  });

  it('writes nothing twice when the rows are already there', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS });
    replayCompactionsAt(s.hippoRoot, log);
    run(s.hippoRoot, `UPDATE compactions SET status = 'summarised', summarised_at = ?`, ago(20));
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(logs.join('\n')).toContain('skipped 2 item(s) an earlier compaction already saved');
  });

  it('never turns an item the record had redacted into a row', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ['The release bot deploys with the token [REDACTED] so rotate it monthly.', ITEMS[0]] });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionMemories(s.hippoRoot).map((r) => r.content)).toEqual([ITEMS[0]]);
    expect(logs.join('\n')).toContain('skipped 1 item(s) as secret');
  });

  it('imports a spool file, deletes it, and sets a broken one aside', () => {
    const spool = path.join(s.hippoRoot, 'compactions-spool');
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(
      path.join(spool, 's1-1.json'),
      JSON.stringify({ sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: null, at: ago(30), summary: 'the summary', items: ITEMS }),
    );
    fs.writeFileSync(path.join(spool, 's2-1.json'), '{ not json');
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(fs.readdirSync(spool).sort()).toEqual(['s2-1.json.bad']);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2, summary: 'the summary' }]);
  });

  it('fills a started record from the isCompactSummary entry in its transcript', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(
      transcript,
      [
        transcriptLine(60, false, 'Fix the flaky login test.'),
        transcriptLine(29, true, CONTINUED(ITEMS)),
        transcriptLine(20, false, 'Thanks, carry on.'),
      ].join('\n') + '\n',
    );
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    const [record] = compactionRows(s.hippoRoot);
    expect(record.status).toBe('done');
    expect(record.summary).toContain('Primary Request');
    expect(JSON.parse(record.items_json!)).toEqual(ITEMS);
  });

  it('ignores a compact summary written before the record started, and a record under 10 minutes old', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(50, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-old', status: 'started', startedMinutesAgo: 30, transcript });
    fs.writeFileSync(path.join(s.proj, 'fresh.jsonl'), transcriptLine(1, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-new', status: 'started', startedMinutesAgo: 3, transcript: path.join(s.proj, 'fresh.jsonl'), session: 's2' });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(compactionRows(s.hippoRoot).map((r) => r.status)).toEqual(['started', 'started']);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
  });

  it('gives each compaction in one session only the summary written after its own start', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(39, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 40, transcript });
    seed(s.hippoRoot, { id: 'cmp-2', status: 'started', startedMinutesAgo: 20, transcript });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionRows(s.hippoRoot).map((r) => [r.id, r.status])).toEqual([['cmp-1', 'done'], ['cmp-2', 'started']]);
  });

  it('returns 0 and logs instead of throwing when the store cannot be opened', () => {
    const notADirectory = path.join(s.dir, 'a-file');
    fs.writeFileSync(notADirectory, 'x');
    expect(replayCompactionsAt(path.join(notADirectory, 'store'), log)).toBe(0);
    expect(logs.join('\n')).toContain('replay failed');
  });

  it('skips a record whose transcript is gone without failing the rest', () => {
    seed(s.hippoRoot, { id: 'cmp-gone', status: 'started', startedMinutesAgo: 30, transcript: path.join(s.proj, 'missing.jsonl') });
    seed(s.hippoRoot, { id: 'cmp-2', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS, session: 's2' });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionRows(s.hippoRoot).map((r) => [r.id, r.status]).sort()).toEqual([['cmp-2', 'done'], ['cmp-gone', 'started']]);
  });
});

describe('hippo sleep finishes what the hook could not', () => {
  const sleep = () => runHippo(['sleep', '--no-learn', '--no-share'], s.proj, s.env);

  it('a hook killed after the record step: sleep writes the items once', () => {
    initProject(s);
    const hook = runHippo(['post-compact'], s.proj, s.env, fixturePayload(0, { cwd: s.proj }));
    expect(oneLine(hook.stdout)).toBe('Hippo saved 4 memories from this compaction.');

    run(s.hippoRoot, `DELETE FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0`);
    run(s.hippoRoot, `UPDATE compactions SET status = 'summarised', items_written = 0, summarised_at = ?`, ago(20));
    expect(compactionMemories(s.hippoRoot)).toEqual([]);

    const first = sleep();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Finished saving 1 compaction left over');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(4);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 4 }]);

    expect(sleep().status).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(4);
  }, 60_000);

  it('a dry run replays nothing', () => {
    initProject(s);
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS });
    expect(runHippo(['sleep', '--no-learn', '--dry-run'], s.proj, s.env).status).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('summarised');
  });

  it('a locked store makes the hook spool inside its budget, and sleep imports the spool', () => {
    initProject(s);
    const db = openHippoDb(s.hippoRoot);
    let elapsed = 0;
    try {
      db.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      const hook = runHippo(['post-compact'], s.proj, s.env, postCompactPayload('s1', s.proj, summaryWith(ITEMS)));
      elapsed = Date.now() - started;
      expect(hook.status).toBe(0);
      expect(oneLine(hook.stdout)).toBe('Hippo will finish saving this compaction at the next sleep.');
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
    expect(elapsed).toBeLessThan(9000);

    const spool = path.join(s.hippoRoot, 'compactions-spool');
    expect(fs.readdirSync(spool).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);

    expect(sleep().status).toBe(0);
    expect(fs.readdirSync(spool)).toEqual([]);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  }, 60_000);

  it('the next post-compact also finishes an earlier compaction', () => {
    initProject(s);
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS, session: 'earlier' });
    const hook = runHippo(['post-compact'], s.proj, s.env, postCompactPayload('s2', s.proj, summaryWith(['The staging database is reset every Sunday night by the platform team.'])));
    expect(oneLine(hook.stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(3);
    expect(compactionRows(s.hippoRoot).map((r) => r.status)).toEqual(['done', 'done']);
  }, 60_000);
});
