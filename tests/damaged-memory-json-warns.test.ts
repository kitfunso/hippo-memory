// A memory row whose JSON column will not parse still reads, as empty, and the row is named once at warn so the damage can be found.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { appendSessionEvent, listSessionEvents } from '../src/store/sessions.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { resetLogOnce } from '../src/util/log.js';

const TENANT = 'default';
const PRIVATE_TEXT = 'private-tag-text';
const dirs: string[] = [];
let stderr: MockInstance<typeof process.stderr.write>;

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-damaged-json-'));
  dirs.push(root);
  initStore(root);
  return root;
}

function runSql(root: string, sql: string, ...params: Array<string | number>): void {
  const db = openHippoDb(root);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeHippoDb(db);
  }
}

const damageLines = (): string[] => stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('read as empty'));

beforeEach(() => {
  resetLogOnce();
  vi.stubEnv('HIPPO_LOG', 'warn');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a memory row with a damaged JSON column', () => {
  it('reads with empty tags and is named once at warn, however often it is read', () => {
    const root = newRoot();
    const entry = createMemory('row whose tags were cut short', { tags: ['kept'], baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    writeEntry(root, entry);
    runSql(root, 'UPDATE memories SET tags_json = ? WHERE id = ?', `["${PRIVATE_TEXT}`, entry.id);

    expect(readEntry(root, entry.id)?.tags).toEqual([]);

    expect(damageLines()).toHaveLength(1);
    expect(damageLines()[0]).toMatch(
      new RegExp(`^\\[hippo\\] warn: store: memories\\.tags_json is not valid JSON; read as empty .*table=memories id=${entry.id} column=tags_json`),
    );
    expect(damageLines()[0]).not.toContain(PRIVATE_TEXT);

    expect(readEntry(root, entry.id)?.tags).toEqual([]);
    expect(loadAllEntries(root).map((e) => e.tags)).toEqual([[]]);
    expect(damageLines()).toHaveLength(1);
  });

  it('names each damaged column of a row, and each damaged row, on its own line', () => {
    const root = newRoot();
    const first = createMemory('first damaged row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    const second = createMemory('second damaged row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    writeEntry(root, first);
    writeEntry(root, second);
    runSql(root, `UPDATE memories SET conflicts_with_json = '[', parents_json = '{' WHERE id = ?`, first.id);
    runSql(root, `UPDATE memories SET tags_json = 'nope' WHERE id = ?`, second.id);

    const read = loadAllEntries(root);

    expect(read.map((e) => [e.conflicts_with, e.parents, e.tags])).toEqual([[[], [], []], [[], [], []]]);
    expect(damageLines().map((line) => /id=(\S+) column=(\S+)/.exec(line)?.slice(1, 3).join(' ')).sort()).toEqual(
      [`${first.id} conflicts_with_json`, `${first.id} parents_json`, `${second.id} tags_json`].sort(),
    );
  });

  it('leaves a clean row silent', () => {
    const root = newRoot();
    writeEntry(root, createMemory('clean row', { tags: ['a'], baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT }));

    expect(loadAllEntries(root).map((e) => e.tags)).toEqual([['a']]);
    expect(damageLines()).toEqual([]);
  });
});

describe('a session event with damaged metadata', () => {
  it('reads with empty metadata and is named once at warn', () => {
    const root = newRoot();
    const event = appendSessionEvent(root, TENANT, { session_id: 'sess-1', event_type: 'note', content: 'x', source: 'test', metadata: { a: 1 } });
    runSql(root, `UPDATE session_events SET metadata_json = '{"a":' WHERE id = ?`, event.id);

    expect(listSessionEvents(root, TENANT, { session_id: 'sess-1' }).map((e) => e.metadata)).toEqual([{}]);
    listSessionEvents(root, TENANT, { session_id: 'sess-1' });

    expect(damageLines()).toHaveLength(1);
    expect(damageLines()[0]).toMatch(
      new RegExp(`warn: store: session_events\\.metadata_json is not valid JSON; read as empty .*table=session_events id=${event.id} column=metadata_json`),
    );
  });
});
