// The reader's tool-failure listing, lesson link and origin field, on rows the built `hippo capture-error` wrote.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initStore } from '../../src/store/open.js';
import { DELIVERY_LEDGER_VERSION } from '../../src/store/delivery-recorder.js';
import type { DeliveryEventInput } from '../../src/store/port/delivery.js';
import { writeDeliveryEventOnHandle } from '../../src/store/recall-trace.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { blockHash } from '../../src/util/token-text.js';
import { realpathOrResolve } from '../../src/util/real-path.js';
import type { JsonValue } from '../../src/util/json.js';
import { trySymlink } from '../_helpers/symlink.js';
import {
  dispose,
  hippo,
  hippoIn,
  project,
  withDb,
  type Config as ProjectConfig,
  type Project,
  type RunOptions,
} from '../_helpers/delivery-boundary.js';
import {
  configure,
  expectVerdict,
  fireIn,
  listingOf,
  seed,
  verdictOf,
  writeHostTranscript,
  type ReadOptions,
  type TurnSpec,
  type Verdict,
} from '../_helpers/host-transcript.js';

// Capture-error runs in process; TF1, TF12 and TF13 spawn it once each, far inside the 30 s process-project timeout.

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'z10-reconstruct.mjs');
const V = DELIVERY_LEDGER_VERSION;
const HIPPO_JS = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');
const P1 = 'first question about deploys';
const P2 = 'second question about the test suite';
const ERR_ALPHA = 'Command failed with exit code 2: the alpha package build cannot find its manifest file';
const ERR_BETA = 'Command failed with exit code 3: the beta service migration lost its database connection';
const RECALL_PROMPT = 'why does the alpha package build keep failing, it cannot find the manifest file';
const ROUTINE = {
  tool_input: { command: 'grep -r zebra src' },
  error: 'Command failed with exit code 1: no output produced',
};

type Row = { [column: string]: string | number | null };
type Param = string | number;
type Over = { [field: string]: JsonValue | undefined };

const made: Project[] = [];
afterEach(() => {
  for (const x of made.splice(0)) dispose(x);
});
let p: Project;
const mk = (config?: ProjectConfig): Project => {
  const x = project(config);
  made.push(x);
  return x;
};

function rowsAt(root: string, sql: string, params: Param[] = []): Row[] {
  const db = new DatabaseSync(path.join(root, 'hippo.db'), { readOnly: true });
  try {
    // SAFETY: callers pass a SELECT; rows are column-name to cell maps.
    return db.prepare(sql).all(...params) as Row[];
  } finally {
    db.close();
  }
}
const rows = (sql: string, root: string = p.hippoRoot, params: Param[] = []): Row[] => rowsAt(root, sql, params);
const EV_COLS =
  'id, event_type, turn_seq, duplicate_of, tool_use_id, failure_id, ledger_version, runtime, session_state, tenant_id, store_hash';
const events = (session: string, root: string = p.hippoRoot, tenant = 'default'): Row[] =>
  rows(`SELECT ${EV_COLS} FROM delivery_events WHERE tenant_id = ? AND session_id = ? ORDER BY id`, root, [
    tenant,
    session,
  ]);
const logs = (root: string = p.hippoRoot): Row[] =>
  rows('SELECT id, outcome, tool, sig_hash FROM failure_log ORDER BY id', root);
const lessons = (root: string = p.hippoRoot): Row[] =>
  rows("SELECT id, content FROM memories WHERE source = 'tool-failure' ORDER BY created, id", root);
const lessonWith = (word: string): string => String(lessons().find((m) => String(m.content).includes(word))?.id);
const callKey = (e: Row) => [e.event_type, e.turn_seq, e.duplicate_of, e.tool_use_id];
const num = (v: string | number | null | undefined): number => Number(v);

const payload = (session: string, over: Over = {}): string =>
  JSON.stringify({
    session_id: session,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
    error: ERR_ALPHA,
    tool_use_id: 'toolu_1',
    ...over,
  });

/** One `hippo capture-error` run, in process unless `spawned`; the hook prints nothing and always exits 0. */
async function fail(
  at: Project,
  session: string,
  over: Over = {},
  opts: RunOptions & { args?: string[]; spawned?: boolean } = {},
) {
  const { args = ['capture-error'], spawned = false, ...run } = opts;
  const r = spawned
    ? hippo(at, args, { ...run, input: payload(session, over) })
    : await hippoIn(at, args, { ...run, input: payload(session, over) });
  expect([r.status, r.stdout]).toEqual([0, '']);
  return r;
}

/** One `hippo capture-error` run with every prepared statement that starts with `sqlPrefix` made to throw. */
function failWhere(at: Project, session: string, sqlPrefix: string, over: Over = {}) {
  const preload = path.join(at.dir, `throw-${sqlPrefix.replace(/\W+/g, '-')}.mjs`);
  fs.writeFileSync(
    preload,
    `
import { DatabaseSync } from 'node:sqlite';
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
  if (sql.trimStart().startsWith(${JSON.stringify(sqlPrefix)})) throw new Error('injected failure');
  return original.call(this, sql, ...rest);
};
`,
  );
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HIPPO_JS, 'capture-error'], {
    cwd: at.cwd,
    env: at.env,
    input: payload(session, over),
    encoding: 'utf8',
  });
  expect([r.status, r.stdout]).toEqual([0, '']);
  return r;
}

const list = (session: string, extra: { store?: string; global?: string | false; tenant?: string } = {}) =>
  listingOf({ store: p.hippoRoot, session, ...extra });
const read = (session: string, memory: string, extra: ReadOptions & { store?: string } = {}) =>
  verdictOf({ store: p.hippoRoot, session, memory, ...extra });
const doc = (session: string, specs: TurnSpec[]): string => writeHostTranscript(p, specs, { name: session });

/** A junction to `target`, or null when this machine cannot create one. */
function link(target: string, l: string): string | null {
  return trySymlink(target, l, 'junction') ? l : null;
}

describe('tool-failure listing, lesson and origin', () => {
  it('TF1 a stored failure is listed after prompt 1, and its lesson reaches prompt 2 with the failure as origin', async () => {
    p = mk();
    configure(p, { promptRecall: true });
    const r1 = await fireIn(p, 'tf1', P1);
    await fail(p, 'tf1', { tool_use_id: 'toolu_tf1' }, { spawned: true });
    const r2 = await fireIn(p, 'tf1', RECALL_PROMPT);
    const ev = events('tf1');
    const log = logs();
    expect(
      ev.map((e) => [
        e.event_type,
        e.turn_seq,
        e.duplicate_of,
        e.tool_use_id,
        e.failure_id,
        e.ledger_version,
        e.runtime,
      ]),
    ).toEqual([
      ['prompt-submit', 1, null, null, null, V, 'claude-code'],
      ['tool-failure', 1, null, 'toolu_tf1', log[0].id, V, 'claude-code'],
      ['prompt-submit', 2, null, null, null, V, 'claude-code'],
    ]);
    expect(log.map((l) => [l.outcome, l.tool])).toEqual([['stored', 'Bash']]);
    const [lesson] = lessons();
    expect(lessons()).toHaveLength(1);
    const id = String(lesson.id);
    expect(
      rows('SELECT pool, outcome, stage FROM delivery_candidates WHERE event_id = ? AND memory_id = ?', p.hippoRoot, [
        num(ev[2].id),
        id,
      ]),
    ).toEqual([{ pool: 'prompt-recall', outcome: 'emitted', stage: 'final' }]);
    const listing = list('tf1');
    expect(listing.entries).toEqual([
      {
        event_id: ev[1].id,
        turn_seq: 1,
        after_prompt_turn: 1,
        tool_use_id: 'toolu_tf1',
        failure_id: log[0].id,
        outcome: 'stored',
        tool: 'Bash',
        duplicates: 0,
        lesson: id,
      },
    ]);
    expect(listing.notes).toEqual([]);
    const v = read('tf1', id, {
      transcript: doc('tf1', [
        { prompt: P1, stdout: r1.stdout },
        { prompt: RECALL_PROMPT, stdout: r2.stdout },
      ]),
    });
    expectVerdict(v, {
      store: p.hippoRoot,
      session: 'tf1',
      memory: id,
      class: 'application-unknown',
      reason: null,
      turn: { event_id: num(ev[2].id), turn_seq: 2 },
      stage: 'final',
    });
    expect([v.turns.at(-1)?.delivery, v.turns.at(-1)?.pool, v.turns.at(-1)?.outcome]).toEqual([
      'confirmed',
      'prompt-recall',
      'emitted',
    ]);
    expect(v.turns.map((t) => t.event_id)).toEqual([ev[0].id, ev[2].id]);
    expect(v.origin).toBe(ev[1].id);
    expect(v.notes).toContain(`tool-failure:${ev[1].id}`);
  });

  it('TF2 a routine failure is listed as skipped-routine with no lesson and no memory', async () => {
    p = mk();
    await fail(p, 'tf2', ROUTINE);
    const [row] = events('tf2');
    expect([callKey(row), row.failure_id, row.ledger_version]).toEqual([
      ['tool-failure', 1, null, 'toolu_1'],
      logs()[0].id,
      V,
    ]);
    expect(lessons()).toEqual([]);
    expect(list('tf2').entries).toEqual([
      {
        event_id: row.id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_1',
        failure_id: row.failure_id,
        outcome: 'skipped-routine',
        tool: 'Bash',
        duplicates: 0,
        lesson: null,
      },
    ]);
  });

  it('TF3 duplicated fires of two tool calls give two entries; a repeated error text is a duplicate with no lesson', async () => {
    p = mk();
    for (const id of ['toolu_a', 'toolu_a', 'toolu_b', 'toolu_b']) await fail(p, 'tf3', { tool_use_id: id });
    const ev = events('tf3');
    const log = logs();
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_a'],
      ['tool-failure', null, ev[0].id, 'toolu_a'],
      ['tool-failure', 2, null, 'toolu_b'],
      ['tool-failure', null, ev[2].id, 'toolu_b'],
    ]);
    expect(ev.map((e) => e.failure_id)).toEqual(log.map((l) => l.id));
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'duplicate', 'duplicate', 'duplicate']);
    expect(log[2].sig_hash).toBe(log[0].sig_hash);
    const lesson = String(lessons()[0].id);
    expect(lessons()).toHaveLength(1);
    const listing = list('tf3');
    expect(
      listing.entries.map((e) => [
        e.event_id,
        e.turn_seq,
        e.tool_use_id,
        e.failure_id,
        e.outcome,
        e.duplicates,
        e.lesson,
      ]),
    ).toEqual([
      [ev[0].id, 1, 'toolu_a', log[0].id, 'stored', 1, lesson],
      [ev[2].id, 2, 'toolu_b', log[2].id, 'duplicate', 1, null],
    ]);
    const v = read('tf3', lesson);
    expect(v.origin).toBe(ev[0].id);
    expect(v.turns).toEqual([]);
    expect(v.notes).toEqual(
      expect.arrayContaining([
        `tool-failure:${ev[0].id}`,
        `tool-failure-duplicate:${ev[1].id}`,
        `tool-failure:${ev[2].id}`,
        `tool-failure-duplicate:${ev[3].id}`,
      ]),
    );
  });

  it('TF4 two lesson-worthy failures with distinct ids link to their own memories', async () => {
    p = mk();
    await fail(p, 'tf4', { tool_use_id: 'toolu_alpha', error: ERR_ALPHA });
    await fail(p, 'tf4', { tool_use_id: 'toolu_beta', error: ERR_BETA });
    const ev = events('tf4');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_alpha'],
      ['tool-failure', 2, null, 'toolu_beta'],
    ]);
    const { entries } = list('tf4');
    expect(entries.map((e) => [e.event_id, e.outcome, e.lesson])).toEqual([
      [ev[0].id, 'stored', lessonWith('alpha')],
      [ev[1].id, 'stored', lessonWith('beta')],
    ]);
    expect(new Set(entries.map((e) => e.lesson)).size).toBe(2);
  });

  it('TF5 with no tool_use_id two fires give two numbered rows', async () => {
    p = mk();
    await fail(p, 'tf5', { tool_use_id: undefined });
    await fail(p, 'tf5', { tool_use_id: undefined });
    const ev = events('tf5');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, null],
      ['tool-failure', 2, null, null],
    ]);
    const { entries } = list('tf5');
    expect(entries.map((e) => [e.event_id, e.tool_use_id, e.outcome, e.duplicates])).toEqual([
      [ev[0].id, null, 'stored', 0],
      [ev[1].id, null, 'duplicate', 0],
    ]);
  });

  it('TF6 a sub-agent failure is an unnumbered row, not listed, and noted on a class read', async () => {
    p = mk();
    await fireIn(p, 'tf6', P1);
    await fail(p, 'tf6', { agent_id: 'agent-1', tool_use_id: 'toolu_sub' });
    const ev = events('tf6');
    expect(ev.map((e) => [e.event_type, e.session_state, e.turn_seq, e.duplicate_of])).toEqual([
      ['prompt-submit', 'payload', 1, null],
      ['tool-failure', 'subagent', null, null],
    ]);
    expect(list('tf6')).toEqual({ entries: [], notes: [] });
    const lesson = String(lessons()[0].id);
    const v = read('tf6', lesson);
    expect(v.notes).toEqual(expect.arrayContaining([`subagent:${ev[1].id}`, `subagent-outcome:${ev[1].id}:none`]));
    expect(v.notes.some((n) => n.startsWith('tool-failure'))).toBe(false);
    expect([v.origin, v.turns.length]).toEqual([null, 1]);
  });

  it('TF7 prompt, failure, prompt, failure: after_prompt_turn is 1 then 2', async () => {
    p = mk();
    await fireIn(p, 'tf7', P1);
    await fail(p, 'tf7', { tool_use_id: 'toolu_7a', error: ERR_ALPHA });
    await fireIn(p, 'tf7', P2);
    await fail(p, 'tf7', { tool_use_id: 'toolu_7b', error: ERR_BETA });
    const ev = events('tf7');
    expect(ev.map((e) => [e.event_type, e.turn_seq])).toEqual([
      ['prompt-submit', 1],
      ['tool-failure', 1],
      ['prompt-submit', 2],
      ['tool-failure', 2],
    ]);
    expect(list('tf7').entries.map((e) => [e.event_id, e.turn_seq, e.after_prompt_turn])).toEqual([
      [ev[1].id, 1, 1],
      [ev[3].id, 2, 2],
    ]);
  });

  it('TF8 a Copilot failure carries runtime copilot and no tool_use_id, so two fires stay two rows', async () => {
    p = mk();
    const copilot = JSON.stringify({
      sessionId: 'tf8',
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: 'make all' }),
      error: ERR_ALPHA,
    });
    for (let i = 0; i < 2; i++) {
      const r = await hippoIn(p, ['capture-error', '--runtime', 'copilot'], { input: copilot });
      expect([r.status, r.stdout]).toEqual([0, '']);
    }
    const ev = events('tf8');
    expect(
      ev.map((e) => [
        e.event_type,
        e.runtime,
        e.session_state,
        e.turn_seq,
        e.duplicate_of,
        e.tool_use_id,
        e.ledger_version,
      ]),
    ).toEqual([
      ['tool-failure', 'copilot', 'payload', 1, null, null, V],
      ['tool-failure', 'copilot', 'payload', 2, null, null, V],
    ]);
    expect(list('tf8').entries.map((e) => [e.event_id, e.tool_use_id, e.tool, e.outcome])).toEqual([
      [ev[0].id, null, 'bash', 'stored'],
      [ev[1].id, null, 'bash', 'duplicate'],
    ]);
  });
});

describe('lesson links and the ledger loss window', () => {
  it('TF11 a forgotten lesson is not replaced by a later failure with the same signature', async () => {
    p = mk();
    await fail(p, 'tf11', { tool_use_id: 'toolu_first' });
    const first = String(lessons()[0].id);
    const gone = await hippoIn(p, ['forget', first]);
    expect(gone.status, gone.stderr).toBe(0);
    expect(lessons()).toEqual([]);
    await fail(p, 'tf11', { tool_use_id: 'toolu_second' });
    const ev = events('tf11');
    const log = logs();
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'stored']);
    const second = String(lessons()[0].id);
    expect(second).not.toBe(first);
    const note = `lesson-superseded:${ev[0].id}:${log[1].id}`;
    const listing = list('tf11');
    expect(listing.entries.map((e) => [e.event_id, e.lesson])).toEqual([
      [ev[0].id, null],
      [ev[1].id, second],
    ]);
    expect(listing.notes).toEqual([note]);
    const v = read('tf11', second);
    expect(v.origin).toBe(ev[1].id);
    expect(v.notes).toContain(note);
  });

  it('TF12 when the failure_log write throws the hook still writes one row with no failure_id, listed as log-missing', async () => {
    p = mk();
    failWhere(p, 'tf12', 'INSERT INTO failure_log', { tool_use_id: 'toolu_loss' });
    const ev = events('tf12');
    expect(ev.map((e) => [e.event_type, e.tool_use_id, e.failure_id])).toEqual([['tool-failure', 'toolu_loss', null]]);
    expect(list('tf12').entries.map((e) => [e.event_id, e.outcome, e.lesson])).toEqual([
      [ev[0].id, 'log-missing', null],
    ]);
  });

  it('TF13 a stored log row whose ledger row flushed second still names the entry, its lesson and its origin', async () => {
    p = mk();
    failWhere(p, 'tf13', 'INSERT INTO delivery_events', { tool_use_id: 'toolu_race' });
    expect(events('tf13')).toEqual([]);
    await fail(p, 'tf13', { tool_use_id: 'toolu_race' });
    const log = logs();
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'duplicate']);
    const numbered = events('tf13');
    expect(numbered.map(callKey)).toEqual([['tool-failure', 1, null, 'toolu_race']]);
    const input: DeliveryEventInput = {
      ts: new Date().toISOString(),
      tenantId: 'default',
      runtime: 'claude-code',
      eventType: 'tool-failure',
      surface: 'hook',
      storeHash: blockHash(realpathOrResolve(p.hippoRoot)),
      writeStore: 'local',
      projectHash: null,
      sessionId: 'tf13',
      sessionState: 'payload',
      hostTurnId: null,
      promptHash: null,
      promptLength: 0,
      queryHash: null,
      recallTraceId: null,
      blockState: 'empty',
      promptRecall: false,
      consideredCount: 0,
      filteredCount: 0,
      selectedCount: 0,
      emittedCount: 0,
      rejectedCount: 0,
      rejectedUnlisted: 0,
      sectionsShown: 0,
      sectionsDropped: 0,
      budgetTokens: 0,
      selectedTokens: 0,
      injectedTokens: 0,
      staticHash: null,
      recallHash: null,
      emittedHash: null,
      elapsedMs: 1,
      toolUseId: 'toolu_race',
      failureId: num(log[0].id),
      candidates: [],
    };
    expect(withDb(p, (db) => writeDeliveryEventOnHandle(db, input))).not.toBeNull();
    const ev = events('tf13');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_race'],
      ['tool-failure', null, ev[0].id, 'toolu_race'],
    ]);
    const lesson = String(lessons()[0].id);
    expect(list('tf13').entries).toEqual([
      {
        event_id: ev[0].id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_race',
        failure_id: log[0].id,
        outcome: 'stored',
        tool: 'Bash',
        duplicates: 1,
        lesson,
      },
    ]);
    expect(read('tf13', lesson).origin).toBe(ev[0].id);
  });
});

describe('store paths through a link', () => {
  it('TF9a a project reached through a junction and directly writes one store hash, and both paths read every row', async (ctx) => {
    p = mk();
    const L = link(p.proj, path.join(p.dir, 'proj-link'));
    if (L === null) return ctx.skip();
    try {
      await fail(p, 'tf9a', { tool_use_id: 'toolu_via_link' }, { cwd: L });
      await fail(p, 'tf9a', { tool_use_id: 'toolu_direct', error: ERR_BETA });
      const ev = events('tf9a');
      expect(ev.map((e) => [e.event_type, e.turn_seq, e.ledger_version])).toEqual([
        ['tool-failure', 1, V],
        ['tool-failure', 2, V],
      ]);
      expect(ev.map((e) => e.store_hash)).toEqual(Array(2).fill(blockHash(realpathOrResolve(p.hippoRoot))));
      for (const store of [p.hippoRoot, path.join(L, '.hippo')]) {
        const listing = list('tf9a', { store });
        expect(listing.entries.map((e) => e.event_id)).toEqual(ev.map((e) => e.id));
        expect(listing.notes).toEqual([]);
      }
    } finally {
      fs.unlinkSync(L);
    }
  });

  it('TF9b a project .hippo that links to the global store reads its own rows in a class read', async (ctx) => {
    p = mk();
    initStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const proj2 = path.join(p.dir, 'proj2');
    fs.mkdirSync(path.join(proj2, '.git'), { recursive: true });
    const H = link(p.globalRoot, path.join(proj2, '.hippo'));
    if (H === null) return ctx.skip();
    try {
      await fail(p, 'tf9b', {}, { cwd: proj2 });
      const ev = events('tf9b', p.globalRoot);
      expect(ev.map((e) => [e.event_type, e.turn_seq, e.ledger_version])).toEqual([['tool-failure', 1, V]]);
      const want = blockHash(realpathOrResolve(p.globalRoot));
      expect(ev[0].store_hash).toBe(want);
      const lesson = String(lessons(p.globalRoot)[0].id);
      for (const store of [H, p.globalRoot]) {
        const v = read('tf9b', lesson, { store });
        expect([v.store_hash, v.origin, v.memory_id]).toEqual([want, ev[0].id, lesson]);
        expect(v.notes.some((n) => n.startsWith('foreign-store'))).toBe(false);
        expect(v.notes).toContain(`tool-failure:${ev[0].id}`);
      }
    } finally {
      fs.unlinkSync(H);
    }
  });

  it('TF10 version 3 rows keep the two-path rule behind a linked HIPPO_HOME, and a version 3 row with the version 4 hash is foreign', async (ctx) => {
    p = mk();
    initStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const G = link(p.globalRoot, path.join(p.dir, 'global-link'));
    if (G === null) return ctx.skip();
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      for (const [id, error] of [
        ['toolu_t10a', ERR_ALPHA],
        ['toolu_t10b', ERR_BETA],
        ['toolu_t10c', 'Command failed with exit code 4: the gamma queue worker ran out of memory'],
      ]) {
        await fail(p, 'tf10', { tool_use_id: id, error }, { cwd: bare, env: { HIPPO_HOME: G } });
      }
      const ev = events('tf10', p.globalRoot);
      const v4 = blockHash(realpathOrResolve(G));
      expect(ev.map((e) => [e.turn_seq, e.ledger_version, e.store_hash])).toEqual([1, 2, 3].map((n) => [n, V, v4]));
      const onLink = { store: G, global: G };
      expect(list('tf10', onLink).entries.map((e) => e.event_id)).toEqual(ev.map((e) => e.id));
      // Raw SQL: the test is about the reader's version rule, and no binary writes a version 3 row any more.
      const db = new DatabaseSync(path.join(p.globalRoot, 'hippo.db'));
      try {
        const set = db.prepare('UPDATE delivery_events SET ledger_version = 3, store_hash = ? WHERE id = ?');
        set.run(blockHash(path.resolve(G)), num(ev[0].id));
        set.run(blockHash(path.resolve(G)), num(ev[1].id));
        set.run(v4, num(ev[2].id));
      } finally {
        db.close();
      }
      const listing = list('tf10', onLink);
      expect(listing.entries.map((e) => e.event_id)).toEqual([ev[0].id, ev[1].id]);
      expect(listing.notes).toEqual([`foreign-store:${ev[2].id}`]);
      const first = String(lessons(p.globalRoot)[0].id);
      const v = read('tf10', first, { store: G, global: G });
      expect([v.origin, v.store_hash, v.notes.includes(`foreign-store:${ev[2].id}`)]).toEqual([
        ev[0].id,
        blockHash(path.resolve(G)),
        true,
      ]);
    } finally {
      fs.unlinkSync(G);
    }
  });
});

describe('controls', () => {
  const norm = (v: Verdict) => ({
    ...v,
    session_id: '',
    turn: v.turn === null ? null : v.turn.turn_seq,
    turns: v.turns.map((t) => ({
      ...t,
      event_id: 0,
      via_event_id: t.via_event_id === null ? null : 0,
      duplicates: t.duplicates.length,
    })),
    notes: v.notes.filter((n) => !n.startsWith('tool-failure')),
  });

  it('N-TF1 a routine failure between two prompts leaves a delivered and a never-loaded class read unchanged, turns included', async () => {
    p = mk();
    for (let i = 0; i < 3; i++) {
      seed(p.hippoRoot, `office note ${i}: the coffee machine schedule changes for team lunch on friday`, {
        created: `2026-06-0${i + 1}T00:00:00.000Z`,
      });
    }
    const away = seed(p.hippoRoot, 'a lesson from another repo: the staging cluster needs a manual warmup', {
      origin_project: 'some-other-project',
      created: '2026-07-01T00:00:00.000Z',
    });
    const pin = String(rows('SELECT id FROM memories WHERE pinned = 1')[0].id);
    const turns = async (session: string, withFailure: boolean): Promise<TurnSpec[]> => {
      const a = await fireIn(p, session, P1);
      if (withFailure) await fail(p, session, ROUTINE);
      const b = await fireIn(p, session, P2);
      return [
        { prompt: P1, stdout: a.stdout },
        { prompt: P2, stdout: b.stdout },
      ];
    };
    const reads = (session: string, specs: TurnSpec[]) => ({
      pinned: read(session, pin, { transcript: doc(session, specs) }),
      away: read(session, away.id),
    });
    const plain = reads('ntf1-plain', await turns('ntf1-plain', false));
    const failed = reads('ntf1-fail', await turns('ntf1-fail', true));
    expect(events('ntf1-fail').map((e) => [e.event_type, e.turn_seq])).toEqual([
      ['prompt-submit', 1],
      ['tool-failure', 1],
      ['prompt-submit', 2],
    ]);
    expect(rows("SELECT outcome FROM failure_log WHERE outcome != 'skipped-routine'")).toEqual([]);
    expect([plain.pinned.class, plain.pinned.reason, plain.away.class, plain.away.reason]).toEqual([
      'application-unknown',
      null,
      'not-retrieved',
      'not-loaded',
    ]);
    expect(plain.away.turns).toHaveLength(2);
    expect(norm(failed.pinned)).toEqual(norm(plain.pinned));
    expect(norm(failed.away)).toEqual(norm(plain.away));
    const row = events('ntf1-fail')[1];
    expect(failed.away.notes).toContain(`tool-failure:${row.id}`);
  });

  it('N-TF3 a failure whose log row is gone, or never had one, reads log-missing with no lesson', async () => {
    p = mk();
    await fail(p, 'ntf3', { tool_use_id: 'toolu_gone' });
    await fail(p, 'ntf3', { tool_use_id: 'toolu_none', error: ERR_BETA });
    const ev = events('ntf3');
    const log = logs();
    expect(list('ntf3').entries.map((e) => [e.outcome, e.lesson === null])).toEqual([
      ['stored', false],
      ['stored', false],
    ]);
    // Raw SQL: pruning drops log rows on its own clock, and the reader's handling of the dangling id is what is tested.
    const db = new DatabaseSync(path.join(p.hippoRoot, 'hippo.db'));
    try {
      db.prepare('DELETE FROM failure_log WHERE id = ?').run(num(log[0].id));
      db.prepare('UPDATE delivery_events SET failure_id = NULL WHERE id = ?').run(num(ev[1].id));
    } finally {
      db.close();
    }
    expect(lessons()).toHaveLength(2);
    expect(list('ntf3').entries).toEqual([
      {
        event_id: ev[0].id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_gone',
        failure_id: log[0].id,
        outcome: 'log-missing',
        tool: null,
        duplicates: 0,
        lesson: null,
      },
      {
        event_id: ev[1].id,
        turn_seq: 2,
        after_prompt_turn: null,
        tool_use_id: 'toolu_none',
        failure_id: null,
        outcome: 'log-missing',
        tool: null,
        duplicates: 0,
        lesson: null,
      },
    ]);
    expect(read('ntf3', lessonWith('alpha')).origin).toBeNull();
  });

  it("N-TF4 another tenant's failure under the same session id is not listed", async () => {
    p = mk();
    await fail(p, 'ntf4', { tool_use_id: 'toolu_mine' });
    await fail(p, 'ntf4', { tool_use_id: 'toolu_theirs', error: ERR_BETA }, { env: { HIPPO_TENANT: 'other' } });
    expect(events('ntf4').map((e) => e.tool_use_id)).toEqual(['toolu_mine']);
    const theirs = events('ntf4', p.hippoRoot, 'other');
    expect(theirs.map((e) => [e.tenant_id, e.tool_use_id])).toEqual([['other', 'toolu_theirs']]);
    expect(list('ntf4').entries.map((e) => e.tool_use_id)).toEqual(['toolu_mine']);
    expect(list('ntf4', { tenant: 'other' }).entries.map((e) => [e.event_id, e.tool_use_id])).toEqual([
      [theirs[0].id, 'toolu_theirs'],
    ]);
  });

  it('N-TF5 a copied store lists nothing and notes the foreign row', async () => {
    p = mk();
    await fail(p, 'ntf5', { tool_use_id: 'toolu_copy' });
    const [row] = events('ntf5');
    const copyProj = path.join(p.dir, 'copy', 'proj');
    fs.cpSync(p.proj, copyProj, { recursive: true });
    const copy = path.join(copyProj, '.hippo');
    expect(events('ntf5', copy).map((e) => e.id)).toEqual([row.id]);
    expect(list('ntf5').entries).toHaveLength(1);
    expect(list('ntf5', { store: copy })).toEqual({ entries: [], notes: [`foreign-store:${row.id}`] });
  });
});

describe('invariance I4 and the command line', () => {
  const A = { tool_use_id: 'toolu_a' };
  const B = { tool_use_id: 'toolu_b' };
  const CALLS = {
    tf1: [payload('i4', { tool_use_id: 'toolu_tf1' })],
    tf2: [payload('i4', ROUTINE)],
    tf3: [payload('i4', A), payload('i4', A), payload('i4', B), payload('i4', B)],
  };

  async function drive(at: Project, calls: string[]) {
    const runs: Array<[number, string, string]> = [];
    for (const input of calls) {
      const r = await hippoIn(at, ['capture-error'], { input });
      runs.push([
        r.status,
        r.stdout,
        r.stderr
          .split(at.dir)
          .join('<dir>')
          .replace(/\(node:\d+\)/g, '(node:<pid>)'),
      ]);
    }
    const log = rowsAt(at.hippoRoot, 'SELECT * FROM failure_log ORDER BY id').map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && k !== 'ts')),
    );
    const memories = loadAllEntries(at.hippoRoot, 'default')
      .filter((m) => m.source === 'tool-failure')
      .map((m) => ({ content: m.content, tags: m.tags, source: m.source, confidence: m.confidence }));
    return { runs, log, memories };
  }
  const count = (at: Project): number => num(rowsAt(at.hippoRoot, 'SELECT COUNT(*) AS c FROM delivery_events')[0].c);

  it.each(Object.entries(CALLS))(
    'I4 %s: capture-error with the ledger off and on gives the same output, log row and memory',
    async (_name, calls) => {
      const off = mk({ ledger: false });
      const on = mk();
      const a = await drive(off, calls);
      const b = await drive(on, calls);
      expect([count(off), count(on)]).toEqual([0, calls.length]);
      expect(a.runs.map((r) => r[0])).toEqual(calls.map(() => 0));
      expect(b).toEqual(a);
      expect(a.log).toHaveLength(calls.length);
    },
  );

  it('TF-CLI the script prints the listing and refuses --memory, --key or a missing session', async () => {
    p = mk();
    await fail(p, 'cli', { tool_use_id: 'toolu_cli' });
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const ok = run('--store', p.hippoRoot, '--session', 'cli', '--tool-failures', '--no-global');
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(JSON.parse(JSON.stringify(list('cli'))));
    expect(JSON.parse(ok.stdout).entries).toHaveLength(1);
    for (const extra of [
      ['--memory', 'mem_1'],
      ['--key', 'text'],
      ['--memory', 'mem_1', '--key', 'text'],
    ]) {
      const bad = run('--store', p.hippoRoot, '--session', 'cli', '--tool-failures', ...extra);
      expect([bad.status, bad.stdout, bad.stderr.includes('usage:')]).toEqual([2, '', true]);
    }
    const noSession = run('--store', p.hippoRoot, '--tool-failures');
    expect([noSession.status, noSession.stdout]).toEqual([2, '']);
  });
});
