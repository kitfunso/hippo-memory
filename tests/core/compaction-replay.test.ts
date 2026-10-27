import { storeFilesOf } from '../../src/store/sqlite/handles.js';
import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayCompactions, saveCompaction } from '../../src/surface/capture/compaction-record.js';
import { compactionByRequest, saveItems } from '../../src/store/sqlite/compactions-record.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import {
  compactionMemories,
  compactionRows,
  fixturePayload,
  oneLine,
  postCompactPayload,
  removeScratch,
  run,
  runHippo,
  scratch,
  summaryWith,
  type Scratch,
} from '../_helpers/compaction-hooks.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { compactionFolder } from '../_helpers/cli-stores.js';
import { initTestStore } from '../_helpers/store-template.js';
import { log as hippoLog, type LogFields } from '../../src/base/util/log.js';

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
afterEach(() => {
  vi.restoreAllMocks();
  removeScratch(s);
});

const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();
const log = (message: string): void => {
  logs.push(message);
};

interface Seed {
  id: string;
  status: 'started' | 'summarised';
  startedMinutesAgo: number;
  summarizedMinutesAgo?: number;
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
    r.summarizedMinutesAgo === undefined ? null : ago(r.summarizedMinutesAgo),
    r.status === 'summarised' ? 'the summary' : null,
    r.status === 'summarised' ? JSON.stringify(r.items ?? []) : null,
    r.status,
  );
}

function transcriptLine(minutesAgo: number, isSummary: boolean, text: string): string {
  return JSON.stringify({
    type: 'user',
    isCompactSummary: isSummary,
    timestamp: ago(minutesAgo),
    message: { role: 'user', content: text },
  });
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
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId: 's1',
      trigger: 'auto',
      cwd: s.proj,
      transcriptPath: null,
      at: ago(30),
      summary: 'the summary',
      items: ITEMS,
      ...over,
    }),
  );
  return file;
}

describe('replay of records a killed hook left', () => {
  beforeEach(() => initTestStore(s.hippoRoot));

  it('finishes a record left summarised for over 10 minutes, once', async () => {
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(
      compactionMemories(s.hippoRoot)
        .map((r) => r.content)
        .sort(),
    ).toEqual([...ITEMS].sort());
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 2 }]);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
  });

  it('warns about a stalled record with malformed items, naming its id, and still replays the others', async () => {
    const warned = vi.spyOn(hippoLog, 'warnThenDebug').mockImplementation(() => undefined);
    seed(s.hippoRoot, {
      id: 'cmp-bad',
      status: 'summarised',
      startedMinutesAgo: 40,
      summarizedMinutesAgo: 30,
      items: ITEMS,
      session: 's-bad',
    });
    seed(s.hippoRoot, {
      id: 'cmp-good',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    run(s.hippoRoot, `UPDATE compactions SET items_json = '{not json' WHERE id = 'cmp-bad'`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(
      compactionMemories(s.hippoRoot)
        .map((r) => r.content)
        .sort(),
    ).toEqual([...ITEMS].sort());
    expect(warned.mock.calls.map(([, message]) => message).join('')).toContain('compaction cmp-bad skipped');
  });

  it('warns once for several malformed records, so the once-only key set does not grow with the rows', async () => {
    const warned = vi.spyOn(hippoLog, 'warnThenDebug').mockImplementation(() => undefined);
    for (const id of ['cmp-bad-1', 'cmp-bad-2', 'cmp-bad-3']) {
      seed(s.hippoRoot, { id, status: 'summarised', startedMinutesAgo: 40, summarizedMinutesAgo: 30, items: ITEMS });
      run(s.hippoRoot, `UPDATE compactions SET items_json = '{not json' WHERE id = '${id}'`);
    }
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(warned).toHaveBeenCalledTimes(3);
    expect(new Set(warned.mock.calls.map(([key]) => key)).size).toBe(1);
  });

  it('answers a request lookup that lands on a record with malformed items with null and a warning, not a throw', () => {
    const warned = vi.spyOn(hippoLog, 'warnThenDebug').mockImplementation(() => undefined);
    seed(s.hippoRoot, { id: 'cmp-bad', status: 'summarised', startedMinutesAgo: 40, summarizedMinutesAgo: 30 });
    run(s.hippoRoot, `UPDATE compactions SET items_json = '{not json', request_id = 'req-1' WHERE id = 'cmp-bad'`);
    const db = openHippoDb(s.hippoRoot);
    try {
      expect(compactionByRequest(db, { tenantId: 'default', requestId: 'req-1', sessionId: 's1' })).toBeNull();
    } finally {
      closeHippoDb(db);
    }
    expect(warned.mock.calls.map(([, message]) => message).join('')).toContain('compaction cmp-bad skipped');
  });

  it('leaves a record that is under 10 minutes old to its own hook', async () => {
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 5,
      summarizedMinutesAgo: 1,
      items: ITEMS,
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('summarised');
  });

  it('writes nothing twice when the rows are already there', async () => {
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    await replayCompactions(compactionFolder(s.hippoRoot), log);
    run(s.hippoRoot, `UPDATE compactions SET status = 'summarised', summarised_at = ?`, ago(20));
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(logs.join('\n')).toContain('skipped 2 item(s) the store already holds');
  });

  it('never turns an item the record had redacted into a row', async () => {
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ['The release bot deploys with the token [REDACTED] so rotate it monthly.', ITEMS[0]],
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(compactionMemories(s.hippoRoot).map((r) => r.content)).toEqual([ITEMS[0]]);
    expect(logs.join('\n')).toContain('skipped 1 item(s) as secret');
  });

  it('imports a spool file, deletes it, and sets a broken one aside', async () => {
    const spool = path.join(s.hippoRoot, 'compactions-spool');
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(
      path.join(spool, 's1-1.json'),
      JSON.stringify({
        sessionId: 's1',
        trigger: 'auto',
        cwd: s.proj,
        transcriptPath: null,
        at: ago(30),
        summary: 'the summary',
        items: ITEMS,
      }),
    );
    fs.writeFileSync(path.join(spool, 's2-1.json'), '{ not json');
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(fs.readdirSync(spool).sort()).toEqual(['s2-1.unreadable.bad']);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([
      { session_id: 's1', status: 'done', items_written: 2, summary: 'the summary' },
    ]);
  });

  it('fills a started record from the isCompactSummary entry in its transcript', async () => {
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
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    const [record] = compactionRows(s.hippoRoot);
    expect(record.status).toBe('done');
    expect(record.summary).toContain('Primary Request');
    expect(JSON.parse(record.items_json!)).toEqual(ITEMS);
  });

  it('ignores a compact summary written before the record started, and a record under 10 minutes old', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(50, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-old', status: 'started', startedMinutesAgo: 30, transcript });
    fs.writeFileSync(path.join(s.proj, 'fresh.jsonl'), transcriptLine(1, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, {
      id: 'cmp-new',
      status: 'started',
      startedMinutesAgo: 3,
      transcript: path.join(s.proj, 'fresh.jsonl'),
      session: 's2',
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(compactionRows(s.hippoRoot).map((r) => r.status)).toEqual(['no-summary', 'started']);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
  });

  it('gives each compaction in one session only the summary written after its own start', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(39, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 40, transcript });
    seed(s.hippoRoot, { id: 'cmp-2', status: 'started', startedMinutesAgo: 20, transcript });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(compactionRows(s.hippoRoot).map((r) => [r.id, r.status])).toEqual([
      ['cmp-1', 'done'],
      ['cmp-2', 'no-summary'],
    ]);
  });

  it('gives a compaction with no fresh record its own record, and leaves an older started one its own summary', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(89, true, CONTINUED([ITEMS[0]])) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 90, transcript });
    const saved = await saveCompaction(
      compactionFolder(s.hippoRoot),
      {
        sessionId: 's1',
        trigger: 'auto',
        cwd: s.proj,
        transcriptPath: transcript,
        compactSummary: summaryWith([ITEMS[1]]),
      },
      log,
    );
    expect(saved.written).toBe(1);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);

    const [first, second] = compactionRows(s.hippoRoot);
    expect(first).toMatchObject({ id: 'cmp-1', status: 'done' });
    expect(JSON.parse(first.items_json!)).toEqual([ITEMS[0]]);
    expect(second.id).not.toBe('cmp-1');
    expect(JSON.parse(second.items_json!)).toEqual([ITEMS[1]]);
    expect(
      compactionMemories(s.hippoRoot)
        .map((r) => r.content)
        .sort(),
    ).toEqual([...ITEMS].sort());
  });

  it('still gives a summary to the started record its own pre-compact wrote minutes before', async () => {
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 5 });
    await saveCompaction(
      compactionFolder(s.hippoRoot),
      { sessionId: 's1', trigger: 'auto', cwd: s.proj, transcriptPath: null, compactSummary: summaryWith(ITEMS) },
      log,
    );
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ id: 'cmp-1', status: 'done', items_written: 2 }]);
  });

  it('leaves a record another process filled first alone instead of writing a second one', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(29, true, 'Summary:\n1. Primary Request: fix the login test.') + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    // The transcript summary has no memories list, so this log line is the moment between the search and the update.
    const otherProcessFinishes = (message: string): void => {
      log(message);
      if (message.includes('no memories section')) {
        run(s.hippoRoot, `UPDATE compactions SET status = 'done', items_written = 7 WHERE id = 'cmp-1'`);
      }
    };
    expect(await replayCompactions(compactionFolder(s.hippoRoot), otherProcessFinishes)).toBe(0);
    expect(compactionRows(s.hippoRoot)).toMatchObject([
      { id: 'cmp-1', status: 'done', items_written: 7, summary: null },
    ]);
    expect(logs.join('\n')).toContain('cmp-1 was filled by another process');
  });

  it('closes a started record whose transcript has no summary in its window, and does not look again', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(60, false, 'Fix the flaky login test.') + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('no-summary');
    expect(logs.join('\n')).toContain('cmp-1 closed as no-summary');

    fs.appendFileSync(transcript, transcriptLine(25, true, CONTINUED(ITEMS)) + '\n');
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('no-summary');
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
  });

  it('counts the rows it writes in the remembered counter', async () => {
    const remembered = (): number =>
      Number(rows<{ value: string }>(`SELECT value FROM meta WHERE key = 'total_remembered'`)[0]?.value ?? 0);
    const before = remembered();
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(remembered() - before).toBe(2);
  });

  it('returns 0 and logs instead of throwing when the store cannot be opened', async () => {
    const notADirectory = path.join(s.dir, 'a-file');
    fs.writeFileSync(notADirectory, 'x');
    expect(await replayCompactions(compactionFolder(path.join(notADirectory, 'store')), log)).toBe(0);
    expect(logs.join('\n')).toContain('replay failed');
  });

  it('skips a record whose transcript is gone without failing the rest', async () => {
    seed(s.hippoRoot, {
      id: 'cmp-gone',
      status: 'started',
      startedMinutesAgo: 30,
      transcript: path.join(s.proj, 'missing.jsonl'),
    });
    seed(s.hippoRoot, {
      id: 'cmp-2',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
      session: 's2',
    });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(
      compactionRows(s.hippoRoot)
        .map((r) => [r.id, r.status])
        .sort(),
    ).toEqual([
      ['cmp-2', 'done'],
      ['cmp-gone', 'started'],
    ]);
  });
});

describe('two replayers working the same store', () => {
  beforeEach(() => initTestStore(s.hippoRoot));

  it('a stale replayer writes nothing and reports what the first one wrote', () => {
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    const db = openHippoDb(s.hippoRoot);
    try {
      const ctx = {
        tenantId: 'default',
        recordId: 'cmp-1',
        sessionId: 's1',
        originProject: 'proj',
        cwd: null,
        items: ITEMS,
      };
      expect(
        saveItems(db, { files: storeFilesOf(s.hippoRoot), ctx, log, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      ).toBe(2);
      run(s.hippoRoot, `DELETE FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0`);
      expect(
        saveItems(db, { files: storeFilesOf(s.hippoRoot), ctx, log, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      ).toBe(2);
    } finally {
      closeHippoDb(db);
    }
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 2 }]);
    expect(logs.join('\n')).toContain('cmp-1 was already finished by another process');
  });

  it('skips a spool file another replayer has claimed', async () => {
    const claimed = writeSpool('s1-1.json.claimed');
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(fs.existsSync(claimed)).toBe(true);
    expect(compactionRows(s.hippoRoot)).toEqual([]);
  });

  it('recovers and imports a claim whose replayer died', async () => {
    const claimed = writeSpool('s1-1.json.claimed');
    const past = new Date(Date.now() - 20 * MINUTE);
    fs.utimesSync(claimed, past, past);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  });

  it('puts a spool file back when its import fails, so the next replay retries it', async () => {
    writeSpool('s1-1.json');
    run(
      s.hippoRoot,
      `CREATE TRIGGER block_compaction_insert BEFORE INSERT ON compactions BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual(['s1-1.a1.json']);
    expect(logs.join('\n')).toContain('spool file s1-1.json failed to import (try 1 of 3)');

    run(s.hippoRoot, `DROP TRIGGER block_compaction_insert`);
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(1);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('records each spool file under the tenant it was spooled for', async () => {
    writeSpool('sa-1.json', { tenantId: 'acme', sessionId: 'sa', items: [ITEMS[0]] });
    writeSpool('sb-1.json', { sessionId: 'sb', items: [ITEMS[1]] });
    expect(await replayCompactions(compactionFolder(s.hippoRoot), log)).toBe(2);
    expect(rows(`SELECT tenant_id, session_id, status FROM compactions ORDER BY session_id`)).toEqual([
      { tenant_id: 'acme', session_id: 'sa', status: 'done' },
      { tenant_id: 'default', session_id: 'sb', status: 'done' },
    ]);
    expect(
      rows(
        `SELECT tenant_id, content FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0 ORDER BY content`,
      ),
    ).toEqual([
      { tenant_id: 'acme', content: ITEMS[0] },
      { tenant_id: 'default', content: ITEMS[1] },
    ]);
  });
});

describe('hippo sleep finishes what the hook could not', () => {
  const sleep = async () => await runHippo(['sleep', '--no-learn', '--no-share'], s.proj, s.env);

  it('a hook killed after the record step: sleep writes the items once', async () => {
    initTestStore(s.hippoRoot);
    const hook = await runHippo(['post-compact'], s.proj, s.env, fixturePayload(0, { cwd: s.proj }));
    expect(oneLine(hook.stdout)).toBe('Hippo saved 4 memories from this compaction.');

    run(s.hippoRoot, `DELETE FROM memories WHERE instr(tags_json, '"compaction-memory"') > 0`);
    run(s.hippoRoot, `UPDATE compactions SET status = 'summarised', items_written = 0, summarised_at = ?`, ago(20));
    expect(compactionMemories(s.hippoRoot)).toEqual([]);

    const first = await sleep();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Finished saving 1 compaction left over');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(4);
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 4 }]);

    expect((await sleep()).status).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toHaveLength(4);
  });

  it('a dry run replays nothing', async () => {
    initTestStore(s.hippoRoot);
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
    });
    expect((await runHippo(['sleep', '--no-learn', '--dry-run'], s.proj, s.env)).status).toBe(0);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(compactionRows(s.hippoRoot)[0].status).toBe('summarised');
  });

  it('the next post-compact also finishes an earlier compaction', async () => {
    initTestStore(s.hippoRoot);
    seed(s.hippoRoot, {
      id: 'cmp-1',
      status: 'summarised',
      startedMinutesAgo: 30,
      summarizedMinutesAgo: 20,
      items: ITEMS,
      session: 'earlier',
    });
    const hook = await runHippo(
      ['post-compact'],
      s.proj,
      s.env,
      postCompactPayload(
        's2',
        s.proj,
        summaryWith(['The staging database is reset every Sunday night by the platform team.']),
      ),
    );
    expect(oneLine(hook.stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(3);
    expect(compactionRows(s.hippoRoot).map((r) => r.status)).toEqual(['done', 'done']);
  });
});

// The hook waits out its lock waits on the held global store before it spools, so the case runs for seconds by design.
describe('the daily runner finishes the global store', { timeout: 30_000 }, () => {
  it('imports what a hook in a folder with no store of its own spooled into the global store', async () => {
    initTestStore(s.globalRoot);
    const db = openHippoDb(s.globalRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const hook = await runHippo(
        ['post-compact'],
        s.proj,
        s.env,
        postCompactPayload('s1', s.proj, summaryWith(ITEMS)),
      );
      expect(oneLine(hook.stdout)).toBe('Hippo will finish saving this compaction at the next sleep.');
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(compactionMemories(s.globalRoot)).toEqual([]);

    const daily = await runHippo(['daily-runner'], s.dir, s.env);
    expect(daily.status).toBe(0);
    expect(daily.stdout).toContain('Finished saving 1 compaction left over in the global store.');
    expect(fs.readdirSync(path.join(s.globalRoot, 'compactions-spool'))).toEqual([]);
    expect(compactionMemories(s.globalRoot)).toHaveLength(2);
    expect(compactionRows(s.globalRoot)).toMatchObject([{ session_id: 's1', status: 'done', items_written: 2 }]);
  });
});

describe('a replay failure keeps its error fields', () => {
  const caught: { message: string; fields: LogFields | undefined }[] = [];
  const logFields = (message: string, fields?: LogFields): void => {
    caught.push({ message, fields });
  };
  beforeEach(() => {
    caught.length = 0;
  });

  it('the whole replay failing passes the class and stack', async () => {
    const notADirectory = path.join(s.dir, 'a-file');
    fs.writeFileSync(notADirectory, 'x');
    await replayCompactions(compactionFolder(path.join(notADirectory, 'store')), logFields);
    const failed = caught.find((c) => c.message.startsWith('replay failed'));
    expect(failed?.fields).toMatchObject({ errorClass: expect.any(String), stack: expect.any(String) });
  });

  it('a transcript fill failing passes the record id with the error', async () => {
    const transcript = path.join(s.proj, 't.jsonl');
    fs.writeFileSync(transcript, transcriptLine(29, true, CONTINUED(ITEMS)) + '\n');
    seed(s.hippoRoot, { id: 'cmp-1', status: 'started', startedMinutesAgo: 30, transcript });
    const folder = compactionFolder(s.hippoRoot);
    const hooks = {
      ...folder.store.compactionHooks,
      fill: async (): Promise<never> => {
        throw new Error('fill refused');
      },
    };
    await replayCompactions({ ...folder, store: { ...folder.store, compactionHooks: hooks } }, logFields);
    const failed = caught.find((c) => c.message.startsWith('transcript fill of cmp-1 failed'));
    expect(failed?.fields).toMatchObject({ recordId: 'cmp-1', errorClass: 'Error' });
  });

  it('a spool import failing passes the class and stack', async () => {
    writeSpool('s1-1.json');
    const real = nodeFs.readdirSync;
    // SAFETY: the stub forwards every call but the spool folder's to readdirSync; a spy cannot spell its overloads.
    const stub = ((dir: fs.PathLike, ...rest: never[]) => {
      if (String(dir).endsWith('compactions-spool')) throw new Error('EIO: simulated');
      return real(dir, ...rest);
    }) as typeof nodeFs.readdirSync;
    vi.spyOn(nodeFs, 'readdirSync').mockImplementation(stub);
    syncBuiltinESMExports();
    try {
      await replayCompactions(compactionFolder(s.hippoRoot), logFields);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
    const failed = caught.find((c) => c.message.startsWith('spool import failed'));
    expect(failed?.fields).toMatchObject({ errorClass: 'Error', stack: expect.any(String) });
  });
});
