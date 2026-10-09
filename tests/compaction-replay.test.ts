import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPACTION_DB_WAIT_MS, replayCompactionsAt, saveCompaction, saveItems } from '../src/capture/compaction-record.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
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
import { lockWaitAskedMs, tracingLockWaits } from './_helpers/lock-waits.js';

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

function rows<T>(sql: string): T[] {
  const db = openHippoDb(s.hippoRoot);
  try {
    // SAFETY: every caller names the columns its row type declares.
    return db.prepare(sql).all() as T[];
  } finally {
    closeHippoDb(db);
  }
}

const spoolDir = (): string => path.join(s.hippoRoot, 'compactions-spool');

function writeSpool(name: string, over: { tenantId?: string; sessionId?: string; items?: string[] } = {}): string {
  fs.mkdirSync(spoolDir(), { recursive: true });
  const file = path.join(spoolDir(), name);
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: null, at: ago(30), summary: 'the summary', items: ITEMS, ...over }));
  return file;
}

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
    expect(logs.join('\n')).toContain('skipped 2 item(s) the store already holds');
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
    expect(fs.readdirSync(spool).sort()).toEqual(['s2-1.unreadable.bad']);
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
    expect(compactionRows(s.hippoRoot).map((r) => r.status)).toEqual(['no-summary', 'started']);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
  });

  it('gives each compaction in one session only the summary written after its own start', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(39, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 40, transcript });
    seed(s.hippoRoot, { id: 'cmp-2', status: 'started', startedMinutesAgo: 20, transcript });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(compactionRows(s.hippoRoot).map((r) => [r.id, r.status])).toEqual([['cmp-1', 'done'], ['cmp-2', 'no-summary']]);
  });

  it('gives a compaction with no fresh record its own record, and leaves an older started one its own summary', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(89, true, CONTINUED([ITEMS[0]])) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 90, transcript });
    const saved = saveCompaction(s.hippoRoot, { sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: transcript, compactSummary: summaryWith([ITEMS[1]]) }, log);
    expect(saved.written).toBe(1);
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);

    const [first, second] = compactionRows(s.hippoRoot);
    expect(first).toMatchObject({ id: 'cmp-1', status: 'done' });
    expect(JSON.parse(first.items_json!)).toEqual([ITEMS[0]]);
    expect(second.id).not.toBe('cmp-1');
    expect(JSON.parse(second.items_json!)).toEqual([ITEMS[1]]);
    expect(compactionMemories(s.hippoRoot).map((r) => r.content).sort()).toEqual([...ITEMS].sort());
  });

  it('still gives a summary to the started record its own pre-compact wrote minutes before', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 5 });
    saveCompaction(s.hippoRoot, { sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: null, compactSummary: summaryWith(ITEMS) }, log);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ id: 'cmp-1', status: 'done', items_written: 2 }]);
  });

  it('leaves a record another process filled first alone instead of writing a second one', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(29, true, 'Summary:\n1. Primary Request: fix the login test.') + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    // The transcript summary has no memories list, so this log line is the moment between the search and the update.
    const otherProcessFinishes = (message: string): void => {
      log(message);
      if (message.includes('no memories section')) run(s.hippoRoot, `UPDATE compactions SET status = 'done', items_written = 7 WHERE id = 'cmp-1'`);
    };
    expect(replayCompactionsAt(s.hippoRoot, otherProcessFinishes)).toBe(0);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ id: 'cmp-1', status: 'done', items_written: 7, summary: null }]);
    expect(logs.join('\n')).toContain('cmp-1 was filled by another process');
  });

  it('closes a started record whose transcript has no summary in its window, and does not look again', () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(60, false, 'Fix the flaky login test.') + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('no-summary');
    expect(logs.join('\n')).toContain('cmp-1 closed as no-summary');

    fs.appendFileSync(transcript, transcriptLine(25, true, CONTINUED(ITEMS)) + '\n');
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('no-summary');
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
  });

  it('counts the rows it writes in the remembered counter', () => {
    const remembered = (): number => Number(rows<{ value: string }>(`SELECT value FROM meta WHERE key = 'total_remembered'`)[0]?.value ?? 0);
    const before = remembered();
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(remembered() - before).toBe(2);
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

describe('two replayers working the same store', () => {
  beforeEach(() => initStore(s.hippoRoot));

  it('a stale replayer writes nothing and reports what the first one wrote', () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'summarised', startedMinutesAgo: 30, summarisedMinutesAgo: 20, items: ITEMS });
    const db = openHippoDb(s.hippoRoot);
    try {
      const ctx = { tenantId: 'default', recordId: 'cmp-1', sessionId: 's1', originProject: 'proj', cwd: null, items: ITEMS };
      expect(saveItems(db, s.hippoRoot, ctx, log)).toBe(2);
      run(s.hippoRoot, `DELETE FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0`);
      expect(saveItems(db, s.hippoRoot, ctx, log)).toBe(2);
    } finally {
      closeHippoDb(db);
    }
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 2 }]);
    expect(logs.join('\n')).toContain('cmp-1 was already finished by another process');
  });

  it('skips a spool file another replayer has claimed', () => {
    const claimed = writeSpool('s1-1.json.claimed');
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(fs.existsSync(claimed)).toBe(true);
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('recovers and imports a claim whose replayer died', () => {
    const claimed = writeSpool('s1-1.json.claimed');
    const past = new Date(Date.now() - 20 * MINUTE);
    fs.utimesSync(claimed, past, past);
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  });

  it('puts a spool file back when its import fails, so the next replay retries it', () => {
    writeSpool('s1-1.json');
    run(s.hippoRoot, `CREATE TRIGGER block_compaction_insert BEFORE INSERT ON compactions BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual(['s1-1.a1.json']);
    expect(logs.join('\n')).toContain('spool file s1-1.json failed to import (try 1 of 3)');

    run(s.hippoRoot, `DROP TRIGGER block_compaction_insert`);
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(1);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('records each spool file under the tenant it was spooled for', () => {
    writeSpool('sa-1.json', { tenantId: 'acme', sessionId: 'sa', items: [ITEMS[0]] });
    writeSpool('sb-1.json', { sessionId: 'sb', items: [ITEMS[1]] });
    expect(replayCompactionsAt(s.hippoRoot, log)).toBe(2);
    expect(rows(`SELECT tenant_id, session_id, status FROM compactions ORDER BY session_id`)).toEqual([
      { tenant_id: 'acme', session_id: 'sa', status: 'done' },
      { tenant_id: 'default', session_id: 'sb', status: 'done' },
    ]);
    expect(rows(`SELECT tenant_id, content FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0 ORDER BY content`)).toEqual([
      { tenant_id: 'acme', content: ITEMS[0] },
      { tenant_id: 'default', content: ITEMS[1] },
    ]);
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
    const waits = path.join(s.dir, 'lock-waits');
    try {
      db.exec('BEGIN IMMEDIATE');
      const hook = runHippo(['post-compact'], s.proj, tracingLockWaits(s.env, waits), postCompactPayload('s1', s.proj, summaryWith(ITEMS)));
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

describe('the daily runner finishes the global store', () => {
  it('imports what a hook in a folder with no store of its own spooled into the global store', () => {
    initStore(s.globalRoot);
    const db = openHippoDb(s.globalRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const hook = runHippo(['post-compact'], s.proj, s.env, postCompactPayload('s1', s.proj, summaryWith(ITEMS)));
      expect(oneLine(hook.stdout)).toBe('Hippo will finish saving this compaction at the next sleep.');
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(compactionMemories(s.globalRoot)).toEqual([]);

    const daily = runHippo(['daily-runner'], s.dir, s.env);
    expect(daily.status).toBe(0);
    expect(daily.stdout).toContain('Finished saving 1 compaction left over in the global store.');
    expect(fs.readdirSync(path.join(s.globalRoot, 'compactions-spool'))).toEqual([]);
    expect(compactionMemories(s.globalRoot)).toHaveLength(2);
    expect(compactionRows(s.globalRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  }, 60_000);
});
