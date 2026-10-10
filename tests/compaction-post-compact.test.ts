import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { classifyOriginProject } from '../src/core/project-identity.js';
import { syncGlobalToLocal } from '../src/sharing/global-sync.js';
import { initStore } from '../src/store/open.js';
import {
  compactionMemories,
  compactionRows,
  fixturePayload,
  initGlobal,
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

let s: Scratch;
let logFile: string;

beforeEach(() => {
  s = scratch();
  logFile = path.join(s.dir, 'logs', 'pre-compact.log');
});
afterEach(() => removeScratch(s));

function postCompact(input: string, cwd: string = s.proj) {
  return runHippo(['post-compact', '--log-file', logFile], cwd, s.env, input);
}

function log(): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

// Items in each fixture payload, in file order.
const FIXTURE_ITEMS = [4, 1, 2, 2, 0];

describe('hippo post-compact on real PostCompact payloads', () => {
  it.each(FIXTURE_ITEMS.map((count, index) => [index, count]))('payload %i: a done record, %i memories, one line', (index, count) => {
    initProject(s);
    const result = postCompact(fixturePayload(index, { cwd: s.proj, transcript_path: path.join(s.proj, 't.jsonl') }));
    expect(result.status).toBe(0);
    expect(oneLine(result.stdout)).toBe(
      count === 0
        ? "Hippo kept this compaction's summary; it listed no new memories."
        : `Hippo saved ${count} ${count === 1 ? 'memory' : 'memories'} from this compaction.`,
    );

    const [record] = compactionRows(s.hippoRoot);
    expect(record.status).toBe('done');
    expect(record.items_written).toBe(count);
    expect(JSON.parse(record.items_json ?? '[]')).toHaveLength(count);
    expect(record.summary).not.toContain('<analysis>');
    expect(record.summary).not.toContain('<summary>');
    expect(record.summary).toContain('Memories for hippo');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(count);
  });

  it('writes each item as a kept-shape row: distilled, episodic, observed, tagged, sourced to the session', () => {
    initProject(s);
    expect(postCompact(fixturePayload(0, { cwd: s.proj, transcript_path: path.join(s.proj, 't.jsonl') })).status).toBe(0);
    const rows = compactionMemories(s.hippoRoot);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'compaction:3337b50f-afe9-40be-a4a6-5d5f68677982',
        source_session_id: '3337b50f-afe9-40be-a4a6-5d5f68677982',
        kind: 'distilled',
        layer: 'episodic',
        confidence: 'observed',
        origin_project: 'proj',
      });
    }
  });

  it('drops the analysis, redacts a planted secret in the record, and never turns it into a row', () => {
    initProject(s);
    const token = 'ghp_' + 'c'.repeat(36);
    const summary = summaryWith(
      [
        `The release bot deploys with the token ${token} so rotate it each month.`,
        'Reach the release owner at first.last@example.com for deploy approvals.',
        'The staging cache must be flushed after every deploy of the search service.',
      ],
      `1. Primary Request: rotate the deploy token ${token}.`,
    );
    const result = postCompact(postCompactPayload('s1', s.proj, summary));
    expect(oneLine(result.stdout)).toBe('Hippo saved 2 memories from this compaction.');

    const [record] = compactionRows(s.hippoRoot);
    expect(record.summary).not.toContain(token);
    expect(record.summary).toContain('[REDACTED]');
    expect(record.summary).not.toContain('Scratch thinking');
    expect(record.items_json).not.toContain(token);
    expect(record.items_json).not.toContain('first.last@example.com');
    expect(JSON.parse(record.items_json!)).toHaveLength(3);
    expect(record.items_written).toBe(2);

    const contents = compactionMemories(s.hippoRoot).map((r) => r.content);
    expect(contents.join('\n')).not.toContain(token);
    expect(contents.join('\n')).not.toContain('example.com');
    expect(contents).toContain('Reach the release owner at [email] for deploy approvals.');
  });

  it('logs a missing memories section and keeps the summary', () => {
    initProject(s);
    const result = postCompact(postCompactPayload('s1', s.proj, '<summary>\n1. Primary Request: nothing else.\n</summary>'));
    expect(oneLine(result.stdout)).toBe("Hippo kept this compaction's summary; it listed no new memories.");
    expect(log()).toContain('no memories section');
    expect(compactionRows(s.hippoRoot)).toMatchObject([{ status: 'done', items_written: 0 }]);
  });

  it('logs items that are too long or over the row cap, and keeps them in the record', () => {
    initProject(s);
    const long = `The billing service ${'keeps a very long story about its deploy process '.repeat(12)}so it stays in the record only.`;
    const many = Array.from({ length: 11 }, (_, i) => `Memory number ${i + 1} says the search service needs its cache flushed after deploy ${i + 1}.`);
    const result = postCompact(postCompactPayload('s1', s.proj, summaryWith([long, ...many])));
    expect(oneLine(result.stdout)).toBe('Hippo saved 10 memories from this compaction.');
    expect(log()).toContain('item too long: 1');
    expect(log()).toContain('capped: 1');
    expect(JSON.parse(compactionRows(s.hippoRoot)[0].items_json!)).toHaveLength(12);
  });

  it('a payload with no compact_summary saves no memories and prints nothing', () => {
    initProject(s);
    const result = postCompact(postCompactPayload('s1', s.proj, null));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(log()).toContain('no compact_summary');
  });

  it('with no store it writes nothing, prints nothing and exits 0', () => {
    const result = postCompact(fixturePayload(0, { cwd: s.proj }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(fs.existsSync(s.globalRoot)).toBe(false);
    expect(log()).toContain('skip: no hippo store');
  });

  it('a failing record step is logged and the items step still runs', () => {
    initProject(s);
    run(s.hippoRoot, 'DROP TABLE compactions');
    const result = postCompact(postCompactPayload('s1', s.proj, summaryWith(['The search service cache must be flushed after every deploy.'])));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('record step failed');
    expect(oneLine(result.stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(1);
  });
});

function retrievalCount(content: string): number {
  const db = openHippoDb(s.hippoRoot);
  try {
    // SAFETY: row's shape matches the single retrieval_count column named in the SELECT.
    return (db.prepare(`SELECT retrieval_count FROM memories WHERE content = ?`).get(content) as { retrieval_count: number }).retrieval_count;
  } finally {
    closeHippoDb(db);
  }
}

describe('repeated items across compactions', () => {
  const first = 'The billing service uses pnpm, so npm install is never run there.';
  const NOTHING_NEW = "Hippo kept this compaction's summary; it listed no new memories.";

  it('skips an item an earlier compaction of the same session saved, and does not count it as a recall', () => {
    initProject(s);
    expect(postCompact(postCompactPayload('s1', s.proj, summaryWith([first]))).status).toBe(0);
    const second = postCompact(postCompactPayload('s1', s.proj, summaryWith([first, 'The search service cache must be flushed after every deploy.'])));
    expect(oneLine(second.stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
    expect(log()).toContain('skipped 1 item(s) the store already holds');
    expect(compactionRows(s.hippoRoot).map((r) => r.items_written)).toEqual([1, 1]);
    expect(retrievalCount(first)).toBe(0);
  });

  it('counts spacing, case and punctuation changes as a repeat', () => {
    initProject(s);
    expect(postCompact(postCompactPayload('s1', s.proj, summaryWith([first]))).status).toBe(0);
    for (const [session, text] of [['s2', first.replace('pnpm, so', 'pnpm,   so')], ['s3', first.replace('billing', 'Billing')], ['s4', first.replace(', so', '; so')]]) {
      expect(oneLine(postCompact(postCompactPayload(session, s.proj, summaryWith([text]))).stdout)).toBe(NOTHING_NEW);
    }
    expect(compactionMemories(s.hippoRoot)).toHaveLength(1);
    expect(retrievalCount(first)).toBe(3);
  });

  it('counts a rewording that only drops words as a repeat (two real summaries did this)', () => {
    initProject(s);
    const saved = [
      'Recurring Windows scheduled tasks that run console programs are wrapped as `conhost.exe --headless <cmd>`; this was verified against a window watcher.',
      'A Windows child process of a detached Node process needs `windowsHide: true`, or it opens a visible terminal. `tests/child-process-window-hide.test.ts` guards this.',
    ];
    expect(postCompact(postCompactPayload('s1', s.proj, summaryWith(saved))).status).toBe(0);
    const reworded = [
      'Recurring Windows scheduled tasks that run console programs are wrapped as `conhost.exe --headless <cmd>`, verified against a window watcher.',
      'A Windows child process of a detached Node process needs `windowsHide: true`, or it opens a visible terminal.',
    ];
    expect(oneLine(postCompact(postCompactPayload('s1', s.proj, summaryWith(reworded))).stdout)).toBe(NOTHING_NEW);
    expect(compactionMemories(s.hippoRoot).map((r) => r.content)).toEqual([...saved].sort());
  });

  it.each([
    ['a changed number', 'The staging API listens on port 8080.', 'The staging API listens on port 9090.'],
    ['a changed one-digit number', 'The deploy job retries 3 times before paging.', 'The deploy job retries 5 times before paging.'],
    ['a changed word', 'Releases go out on Thursdays after the staging soak.', 'Releases go out on Tuesdays after the staging soak.'],
    ['a dropped negation', 'Releases do not go out on Thursdays after the staging soak.', 'Releases go out on Thursdays after the staging soak.'],
    ['a dropped number', 'The deploy job retries 3 times before paging the on-call.', 'The deploy job retries before paging the on-call.'],
    ['an added detail', 'Never push private data to the public hippo repo.', 'Never push private data to the public hippo repo; scan for secrets first.'],
    ['a short item inside a long memory', 'The billing service uses pnpm, the search service uses npm, the auth service uses yarn and the web app uses bun.', 'The billing service uses pnpm.'],
    ['a correction built from the held words', 'The billing service uses pnpm; the search service uses npm.', 'The search service uses pnpm.'],
    ['two swapped words', 'Use pnpm, not npm, in the billing service.', 'Use npm, not pnpm, in the billing service.'],
    ['two swapped numbers', 'Staging listens on port 8080 and prod on 9090.', 'Staging listens on port 9090 and prod on 8080.'],
    ['a dropped contraction', "Don't deploy the billing service on Fridays.", 'Deploy the billing service on Fridays.'],
    ['a dropped "only"', 'Only run the migrations after the nightly backup finishes.', 'Run the migrations after the nightly backup finishes.'],
  ])('saves %s as a new memory', (_label, earlier, later) => {
    initProject(s);
    expect(postCompact(postCompactPayload('s1', s.proj, summaryWith([earlier]))).status).toBe(0);
    expect(oneLine(postCompact(postCompactPayload('s2', s.proj, summaryWith([later]))).stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(2);
  });

  it('skips an item that restates a memory saved by hand, and strengthens that memory', () => {
    initProject(s);
    expect(runHippo(['remember', first], s.proj, s.env).status).toBe(0);
    expect(oneLine(postCompact(postCompactPayload('s1', s.proj, summaryWith([first.replace(', so', '; so')]))).stdout)).toBe(NOTHING_NEW);
    expect(compactionMemories(s.hippoRoot)).toEqual([]);
    expect(retrievalCount(first)).toBe(1);
  });

  it('a private memory recall hides does not absorb an item', () => {
    initProject(s);
    expect(runHippo(['remember', first], s.proj, s.env).status).toBe(0);
    const db = openHippoDb(s.hippoRoot);
    try {
      db.prepare(`UPDATE memories SET scope = 'slack:private:C1' WHERE content = ?`).run(first);
    } finally {
      closeHippoDb(db);
    }
    expect(oneLine(postCompact(postCompactPayload('s1', s.proj, summaryWith([first]))).stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(1);
  });

  it('two restatements in one summary write one row', () => {
    initProject(s);
    expect(oneLine(postCompact(postCompactPayload('s1', s.proj, summaryWith([first, first.replace('billing', 'Billing')]))).stdout))
      .toBe('Hippo saved 1 memory from this compaction.');
    expect(compactionMemories(s.hippoRoot)).toHaveLength(1);
  });
});

describe('the global store fallback', () => {
  it('stamps each item with the payload cwd origin: same text in another project is written, a repeat in the first is not', () => {
    initGlobal(s);
    const other = path.join(s.dir, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    const summary = summaryWith(['The billing service uses pnpm, so npm install is never run there.']);
    expect(oneLine(postCompact(postCompactPayload('s1', s.proj, summary)).stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(oneLine(postCompact(postCompactPayload('s2', other, summary), other).stdout)).toBe('Hippo saved 1 memory from this compaction.');
    expect(oneLine(postCompact(postCompactPayload('s3', s.proj, summary)).stdout)).toBe("Hippo kept this compaction's summary; it listed no new memories.");

    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(compactionMemories(s.globalRoot).map((r) => r.origin_project).sort()).toEqual(['other', 'proj']);
    expect(compactionRows(s.globalRoot).map((r) => r.origin_project)).toEqual(['proj', 'other', 'proj']);
  });

  it('items are cross-project elsewhere and are not copied down into another project', () => {
    initGlobal(s);
    expect(postCompact(postCompactPayload('s1', s.proj, summaryWith(['The billing service uses pnpm, so npm install is never run there.']))).status).toBe(0);
    const [row] = compactionMemories(s.globalRoot);
    expect(classifyOriginProject(row.origin_project, 'other')).toBe('cross-project');
    expect(classifyOriginProject(row.origin_project, 'proj')).toBe('project');

    const other = path.join(s.dir, 'other');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    const otherRoot = path.join(other, '.hippo');
    initStore(otherRoot);
    expect(syncGlobalToLocal(otherRoot, s.globalRoot)).toBe(0);
  });

  it('a folder with no project marker gives user-global rows', () => {
    initGlobal(s);
    const loose = path.join(s.dir, 'loose');
    fs.mkdirSync(loose);
    expect(postCompact(postCompactPayload('s1', loose, summaryWith(['The billing service uses pnpm, so npm install is never run there.'])), loose).status).toBe(0);
    expect(compactionMemories(s.globalRoot).map((r) => r.origin_project)).toEqual(['']);
    expect(compactionRows(s.globalRoot)[0].origin_project).toBe('');
  });
});
