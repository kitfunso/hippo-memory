// The per-prompt hook end to end through the built CLI: what the delivery ledger records, and that it never changes the hook.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { readDeliveryEvents, type DeliveryEventRow } from '../src/store/recall-trace.js';
import type { DeliveryFault } from '../src/store/delivery-recorder.js';
import { blockHash, estimateTokens } from '../src/util/token-text.js';
import type { HippoConfig } from '../src/core/config.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
// The fault switch has no environment or flag route, so a faulted run starts the same CLI through this entry file.
const FAULT_CLI = path.resolve(__dirname, 'fixtures', 'delivery-fault-cli.mjs');
const HOOK_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
const PROMPT = 'how should the postgres migration rollback plan work';
// After every seeded `created`, real or fixed, so no memory is dated in the future.
const FAKE_NOW = '2099-01-01T00:00:00.000Z';

const BASE_ENV: NodeJS.ProcessEnv = { ...process.env };
delete BASE_ENV.HIPPO_SESSION_ID;
delete BASE_ENV.CLAUDE_CODE_SESSION_ID;
delete BASE_ENV.HIPPO_FAKE_NOW;

interface Payload {
  session_id?: string;
  prompt?: string;
  hook_event_name?: string;
  turn_id?: string;
  agent_id?: string;
}

interface RunOpts {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  fault?: DeliveryFault;
}

let tmp: string;
let proj: string;
const seeded: MemoryEntry[] = [];

const store = (dir: string): string => path.join(dir, '.hippo');

function seed(content: string, extra: Partial<MemoryEntry> = {}, dir = proj): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
  writeEntry(store(dir), entry);
  seeded.push(entry);
  return entry;
}

function configure(ledger: boolean, pinnedInject: Partial<HippoConfig['pinnedInject']> = {}, dir = proj): void {
  fs.writeFileSync(path.join(store(dir), 'config.json'), JSON.stringify({
    deliveryLedger: { enabled: ledger },
    pinnedInject: { promptRecall: false, promptRecallThreshold: 0.1, promptRecallMinShared: 1, ...pinnedInject },
  }));
}

/** A copy of the project with the ledger switched; same folder name, since the project name gates which memories load. */
function clone(ledger: boolean, pinnedInject: Partial<HippoConfig['pinnedInject']> = {}): string {
  const dir = path.join(tmp, `clone-${ledger ? 'on' : 'off'}-${fs.readdirSync(tmp).length}`, 'proj');
  fs.cpSync(proj, dir, { recursive: true });
  configure(ledger, pinnedInject, dir);
  return dir;
}

function run(dir: string, payload: Payload | null, opts: RunOpts = {}): SpawnSyncReturns<string> {
  const entry = opts.fault ? [FAULT_CLI, opts.fault] : [HIPPO_JS];
  return spawnSync(process.execPath, [...entry, ...(opts.args ?? HOOK_ARGS)], {
    cwd: dir,
    env: { ...BASE_ENV, HIPPO_HOME: path.join(dir, 'global'), ...opts.env },
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function claude(sessionId: string, prompt = PROMPT): Payload {
  return { session_id: sessionId, prompt, hook_event_name: 'UserPromptSubmit' };
}

function events(dir: string, sessionId: string | null): DeliveryEventRow[] {
  const db = openHippoDb(store(dir));
  try {
    return readDeliveryEvents(db, 'default', sessionId);
  } finally {
    closeHippoDb(db);
  }
}

/** A session's events, asserting the count first so a second write in one call cannot hide behind destructuring. */
function eventsN(dir: string, sessionId: string | null, n: number): DeliveryEventRow[] {
  const rows = events(dir, sessionId);
  expect(rows).toHaveLength(n);
  return rows;
}

function eventCount(dir: string): number {
  const db = openHippoDb(store(dir));
  try {
    // SAFETY: a single COUNT(*) aggregate aliased `c`.
    return (db.prepare('SELECT COUNT(*) AS c FROM delivery_events').get() as { c: number }).c;
  } finally {
    closeHippoDb(db);
  }
}

const ledgerLines = (stderr: string): string[] => stderr.split('\n').filter((l) => l.includes('delivery ledger'));
const additionalContext = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;
const rejected = (e: DeliveryEventRow) => e.candidates.filter((c) => c.outcome === 'rejected');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-delivery-hook-'));
  proj = path.join(tmp, 'proj');
  fs.mkdirSync(store(proj), { recursive: true });
  initStore(store(proj));
  configure(true);
  seeded.length = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('what one hook call records', () => {
  it('F1: a pin over budget is rejected for budget, and injected tokens price the exact additionalContext', () => {
    const small = seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    const big = seed(`PINNED: ${'the deploy checklist covers every service and region '.repeat(30)}`, { pinned: true });
    const r = run(proj, claude('f1'), { args: [...HOOK_ARGS, '--budget', '200'] });
    expect(r.status).toBe(0);
    const sent = additionalContext(r.stdout);
    const [e] = eventsN(proj, 'f1', 1);
    expect([e.block_state, e.runtime, e.event_type, e.surface, e.session_state, e.turn_seq]).toEqual(['sent', 'claude-code', 'prompt-submit', 'hook', 'payload', 1]);
    expect(e.injected_tokens).toBe(estimateTokens(sent));
    expect(e.emitted_hash).toBe(blockHash(sent));
    expect(e.prompt_hash).toBe(blockHash(PROMPT));
    expect(e.candidates.find((c) => c.memory_id === small.id)?.outcome).toBe('emitted');
    const row = e.candidates.find((c) => c.memory_id === big.id);
    expect([row?.outcome, row?.stage, row?.reason]).toEqual(['rejected', 'budget', 'budget']);
    expect(row?.tokens).toBeGreaterThan(200);
  });

  it('F2: gate rejections carry scores, prompt_recall is set, and rows past the cap only count', () => {
    configure(true, { promptRecall: true, promptRecallMinShared: 2 });
    const relevant = seed('the postgres migration script needs a rollback plan before deploy');
    for (let i = 0; i < 20; i++) seed(`postgres note ${i}: the reporting cluster pools its connections through pgbouncer`);
    const r = run(proj, claude('f2'));
    expect(r.status).toBe(0);
    const [e] = eventsN(proj, 'f2', 1);
    expect(e.prompt_recall).toBe(1);
    expect(e.candidates.find((c) => c.memory_id === relevant.id)).toMatchObject({ outcome: 'emitted', pool: 'prompt-recall' });
    const rows = rejected(e);
    expect(rows).toHaveLength(16);
    expect(rows.every((c) => c.reason === 'gate-below-threshold' && c.score !== null && c.score > 0)).toBe(true);
    expect(e.rejected_count - e.rejected_unlisted).toBe(16);
    expect(e.rejected_unlisted).toBeGreaterThanOrEqual(4);
  });

  it('F3: an unchanged static block on the next turn is recorded as reused under the same hash', () => {
    const pin = seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    expect(run(proj, claude('f3', 'first question about deploys')).stdout).not.toBe('');
    expect(run(proj, claude('f3', 'second question about the test suite')).stdout).toBe('');
    const [first, second] = eventsN(proj, 'f3', 2);
    expect([first.turn_seq, first.block_state, second.turn_seq, second.block_state]).toEqual([1, 'sent', 2, 'reused']);
    expect(second.static_hash).toBe(first.static_hash);
    expect([second.injected_tokens, second.emitted_hash]).toEqual([0, null]);
    expect(second.candidates.find((c) => c.memory_id === pin.id)?.outcome).toBe('reused');
  });

  it('F3b: with prompt recall on, a reused static block beside a sent recall block is one reused-recall-sent event', () => {
    configure(true, { promptRecall: true });
    const pin = seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    const relevant = seed('the postgres migration script needs a rollback plan before deploy');
    expect(run(proj, claude('f3b', 'how should the postgres migration rollback work')).status).toBe(0);
    const r = run(proj, claude('f3b', 'does the postgres migration rollback need a review'));
    expect(r.status).toBe(0);
    const recallSent = additionalContext(r.stdout);
    const [first, second] = eventsN(proj, 'f3b', 2);
    expect([first.block_state, second.block_state, second.turn_seq]).toEqual(['sent', 'reused-recall-sent', 2]);
    expect(second.static_hash).toBe(first.static_hash);
    expect([second.recall_hash, second.emitted_hash]).toEqual([blockHash(recallSent), blockHash(recallSent)]);
    expect(second.candidates.find((c) => c.memory_id === pin.id)?.outcome).toBe('reused');
    expect(second.candidates.find((c) => c.memory_id === relevant.id)).toMatchObject({ outcome: 'emitted', pool: 'prompt-recall' });
  });

  it('F3c: a skip whose token row fails still records one reused event, through the render fallback', () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    expect(run(proj, claude('f3c', 'first question about deploys')).stdout).not.toBe('');
    const db = openHippoDb(store(proj));
    try {
      db.exec(`CREATE TRIGGER block_skip BEFORE INSERT ON token_ledger WHEN NEW.event = 'skip'
        BEGIN SELECT RAISE(ABORT, 'skip row blocked'); END`);
    } finally {
      closeHippoDb(db);
    }
    expect(run(proj, claude('f3c', 'second question about the test suite')).stdout).toBe('');
    const [first, second] = eventsN(proj, 'f3c', 2);
    expect([second.turn_seq, second.block_state, second.static_hash]).toEqual([2, 'reused', first.static_hash]);
    const check = openHippoDb(store(proj));
    try {
      // SAFETY: a single COUNT(*) aggregate aliased `c`.
      const skips = check.prepare(`SELECT COUNT(*) AS c FROM token_ledger WHERE event = 'skip'`).get() as { c: number };
      expect(skips.c).toBe(0);
    } finally {
      closeHippoDb(check);
    }
  });

  it('F4: repeated Claude payloads and Codex turn ids are duplicates; a new turn id or a 10 s gap is not', () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    const now = { HIPPO_FAKE_NOW: FAKE_NOW };
    run(proj, claude('f4'), { env: now });
    run(proj, claude('f4'), { env: now });
    const codex = (turn: string): Payload => ({ ...claude('f4-codex'), turn_id: turn });
    run(proj, codex('t1'), { env: now });
    run(proj, codex('t1'), { env: now });
    run(proj, codex('t2'), { env: now });
    const [a, b] = eventsN(proj, 'f4', 2);
    expect([a.turn_seq, b.turn_seq, b.duplicate_of]).toEqual([1, null, a.id]);
    const [c1, c2, c3] = eventsN(proj, 'f4-codex', 3);
    expect(c1.runtime).toBe('codex');
    expect([c1.host_turn_id, c2.duplicate_of, c2.turn_seq, c3.duplicate_of, c3.turn_seq]).toEqual(['t1', c1.id, null, null, 2]);

    const db = openHippoDb(store(proj));
    try {
      db.prepare('UPDATE delivery_events SET ts = ? WHERE id = ?').run(new Date(Date.parse(FAKE_NOW) - 10_000).toISOString(), a.id);
    } finally {
      closeHippoDb(db);
    }
    run(proj, claude('f4'), { env: now });
    const third = eventsN(proj, 'f4', 3)[2];
    expect([third.duplicate_of, third.turn_seq]).toEqual([null, 2]);
  });

  it('F4b: a blank Codex turn id counts as none, so later turns are not duplicates of the first', () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    run(proj, { ...claude('f4b', 'first question about deploys'), turn_id: '' });
    run(proj, { ...claude('f4b', 'second question about the test suite'), turn_id: '' });
    run(proj, { ...claude('f4b', 'third question about the release'), turn_id: '   ' });
    expect(eventsN(proj, 'f4b', 3).map((e) => [e.host_turn_id, e.turn_seq, e.duplicate_of, e.runtime])).toEqual([
      [null, 1, null, 'claude-code'],
      [null, 2, null, 'claude-code'],
      [null, 3, null, 'claude-code'],
    ]);
  });

  it('F5: concurrent sessions never cross, and turn numbers stay contiguous over the rows written', async () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    const stderrBySession = new Map<string, string[]>([['A', []], ['B', []]]);
    const runAsync = (sessionId: string, prompt: string): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HIPPO_JS, ...HOOK_ARGS], {
        cwd: proj, env: { ...BASE_ENV, HIPPO_HOME: path.join(proj, 'global') },
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        stderrBySession.get(sessionId)?.push(...ledgerLines(stderr));
        if (code === 0) resolve();
        else reject(new Error(`hook exited ${code}: ${stderr}`));
      });
      child.stdin.end(JSON.stringify(claude(sessionId, prompt)));
    });
    for (let round = 0; round < 3; round++) {
      await Promise.all([runAsync('A', `round ${round} question for A`), runAsync('B', `round ${round} question for B`)]);
    }
    for (const sessionId of ['A', 'B']) {
      const rows = events(proj, sessionId);
      expect(rows.every((e) => e.session_id === sessionId)).toBe(true);
      expect(rows.map((e) => e.turn_seq)).toEqual(rows.map((_, i) => i + 1));
      expect(rows.length + (stderrBySession.get(sessionId)?.length ?? 0)).toBe(3);
    }
  }, 60_000);

  it('F6: no session anywhere is missing, an env session is env, and a sub-agent keeps the parent session without a turn', () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    run(proj, { prompt: PROMPT, hook_event_name: 'UserPromptSubmit' });
    run(proj, { prompt: 'another prompt', hook_event_name: 'UserPromptSubmit' }, { env: { HIPPO_SESSION_ID: 'from-env' } });
    run(proj, { ...claude('parent'), agent_id: 'agent-1' });
    const [missing] = eventsN(proj, null, 1);
    expect([missing.session_state, missing.turn_seq, missing.duplicate_of]).toEqual(['missing', null, null]);
    const [env] = eventsN(proj, 'from-env', 1);
    expect([env.session_state, env.turn_seq]).toEqual(['env', 1]);
    const [sub] = eventsN(proj, 'parent', 1);
    expect([sub.session_state, sub.turn_seq]).toEqual(['subagent', null]);
  });

  it('with no local store, the event lands in the global store and hashes that store, not the missing local one', () => {
    const bare = path.join(tmp, 'bare');
    const globalRoot = path.join(bare, 'global');
    fs.mkdirSync(globalRoot, { recursive: true });
    initStore(globalRoot);
    writeEntry(globalRoot, { ...createMemory('PINNED: always check the rollback plan before deploy', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), pinned: true });
    fs.writeFileSync(path.join(globalRoot, 'config.json'), JSON.stringify({
      deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false },
    }));
    expect(run(bare, claude('glob')).status).toBe(0);
    const db = openHippoDb(globalRoot);
    let rows: DeliveryEventRow[];
    try {
      rows = readDeliveryEvents(db, 'default', 'glob');
    } finally {
      closeHippoDb(db);
    }
    expect(rows).toHaveLength(1);
    expect([rows[0].write_store, rows[0].store_hash]).toEqual(['global', blockHash(path.resolve(globalRoot))]);
  });

  it.each([
    ['json', ['context', '--pinned-only', '--include-recent', '5', '--format', 'json']],
    ['markdown', ['context', '--pinned-only', '--include-recent', '5']],
  ])('%s: emitted_hash and injected_tokens describe every stdout byte, trailing newline included', (format, args) => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    const r = run(proj, claude(`bytes-${format}`), { args });
    expect(r.stdout.endsWith('\n')).toBe(true);
    const [e] = eventsN(proj, `bytes-${format}`, 1);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
  });

  it('records disabled for a zero budget, with the session and prompt hash, and when pinned injection is off', () => {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    expect(run(proj, claude('zero'), { args: [...HOOK_ARGS, '--budget', '0'] }).stdout).toBe('');
    const [zero] = eventsN(proj, 'zero', 1);
    expect([zero.block_state, zero.prompt_hash, zero.turn_seq]).toEqual(['disabled', blockHash(PROMPT), 1]);
    configure(true, { enabled: false });
    expect(run(proj, claude('off')).stdout).toBe('');
    expect(eventsN(proj, 'off', 1)[0].block_state).toBe('disabled');
  });
});

describe('the ledger never changes the hook', () => {
  function fixture(): void {
    seed('PINNED: always check the rollback plan before deploy', { pinned: true });
    seed('PINNED: the deploy script lives in the ops folder for every release', { pinned: true });
    seed('the postgres migration script needs a rollback plan before deploy', { created: '2026-05-01T00:00:00.000Z' });
    for (let i = 0; i < 4; i++) {
      seed(`office note ${i}: the coffee machine schedule changes for team lunch on friday`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    }
  }

  it.each<[DeliveryFault]>([
    ['build'],
    ['flush'],
  ])('F7c: a recorder that throws at %s leaves stdout and the exit code as flag-off, with one stderr line', (fault) => {
    fixture();
    const off = run(clone(false), claude('f7c'), { env: { HIPPO_FAKE_NOW: FAKE_NOW } });
    const dir = clone(true);
    const on = run(dir, claude('f7c'), { env: { HIPPO_FAKE_NOW: FAKE_NOW }, fault });
    expect(off.stdout).not.toBe('');
    expect([on.status, on.stdout]).toEqual([off.status, off.stdout]);
    expect(ledgerLines(on.stderr)).toHaveLength(1);
    expect(eventCount(dir)).toBe(0);
  });

  it('F7a: a failing write rolls back, keeps stdout and the exit code, and prints one stderr line', () => {
    fixture();
    const off = run(clone(false), claude('f7a'), { env: { HIPPO_FAKE_NOW: FAKE_NOW } });
    const dir = clone(true);
    const db = openHippoDb(store(dir));
    try {
      db.exec('DROP TABLE delivery_candidates');
    } finally {
      closeHippoDb(db);
    }
    const on = run(dir, claude('f7a'), { env: { HIPPO_FAKE_NOW: FAKE_NOW } });
    expect(off.stdout).not.toBe('');
    expect([on.status, on.stdout]).toEqual([off.status, off.stdout]);
    expect(ledgerLines(on.stderr)).toEqual([expect.stringMatching(/^\[hippo\] error: delivery ledger write failed: /)]);
    expect(eventCount(dir)).toBe(0);
  });

  it('F7d: a render that throws keeps its own exit code and the ledger adds nothing', () => {
    fixture();
    const corrupt = (dir: string): string => {
      fs.writeFileSync(path.join(store(dir), 'hippo.db'), 'not a sqlite database');
      return dir;
    };
    const off = run(corrupt(clone(false)), claude('f7d'));
    const on = run(corrupt(clone(true)), claude('f7d'));
    expect(off.status).not.toBe(0);
    expect([on.status, on.stdout]).toEqual([off.status, off.stdout]);
    expect(ledgerLines(on.stderr)).toEqual([]);
  });

  it('F8: with the flag off nothing is written to the ledger tables', () => {
    fixture();
    configure(false);
    const preload = path.join(tmp, 'preload.mjs');
    const log = path.join(tmp, 'sql.log');
    fs.writeFileSync(preload, `
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
  if (sql.includes('delivery_')) appendFileSync(${JSON.stringify(log)}, sql.replace(/\\s+/g, ' ') + '\\n');
  return original.call(this, sql, ...rest);
};
`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HIPPO_JS, ...HOOK_ARGS], {
      cwd: proj, env: { ...BASE_ENV, HIPPO_HOME: path.join(proj, 'global') }, input: JSON.stringify(claude('f8')), encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toBe('');
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').not.toContain('INSERT INTO delivery_');
    expect(eventCount(proj)).toBe(0);
  });

  const formats: Array<[string, string[]]> = [
    ['the hook', HOOK_ARGS],
    ['pinned-only markdown', ['context', '--pinned-only', '--include-recent', '5']],
    ['pinned-only json', ['context', '--pinned-only', '--include-recent', '5', '--format', 'json']],
  ];
  for (const promptRecall of [true, false]) {
    for (const [label, args] of formats) {
      it(`F9: ${label} prints the same bytes with the flag on and off, promptRecall ${promptRecall ? 'on' : 'off'}`, () => {
        fixture();
        const env = { HIPPO_FAKE_NOW: FAKE_NOW };
        const off = run(clone(false, { promptRecall }), claude('f9'), { args, env });
        const dir = clone(true, { promptRecall });
        const on = run(dir, claude('f9'), { args, env });
        expect(on.status).toBe(0);
        expect([on.status, on.stdout]).toEqual([off.status, off.stdout]);
        expect(on.stdout).not.toBe('');
        expect(events(dir, 'f9')).toHaveLength(1);
      });
    }
  }

  it.each([
    ['the * markdown path', ['context']],
    ['a query', ['context', 'postgres', 'rollback']],
  ])('F9: %s prints the same bytes with the flag on and off and records no event', (_label, args) => {
    fixture();
    const env = { HIPPO_FAKE_NOW: FAKE_NOW };
    const off = run(clone(false), null, { args, env });
    const dir = clone(true);
    const on = run(dir, null, { args, env });
    expect([on.status, on.stdout]).toEqual([off.status, off.stdout]);
    expect(eventCount(dir)).toBe(0);
  });

  it('F10: every ledger text cell is a hash, id, timestamp, session, turn id or enum, never prompt or memory text', () => {
    fixture();
    configure(true, { promptRecall: true });
    run(proj, claude('f10'));
    run(proj, { ...claude('f10-codex'), turn_id: 'turn-9' });
    run(proj, { prompt: PROMPT, hook_event_name: 'UserPromptSubmit' });
    const ids = new Set(seeded.map((m) => m.id));
    const allowed = new Set([
      'default', 'f10', 'f10-codex', 'turn-9',
      'claude-code', 'codex', 'unknown', 'prompt-submit', 'pinned-manual', 'hook', 'context', 'local', 'global',
      'payload', 'env', 'missing', 'subagent', 'sent', 'reused', 'reused-recall-sent', 'empty', 'disabled',
      'pin', 'recent', 'prompt-recall', 'strength', 'search', 'load', 'eligible', 'gate', 'budget', 'limit', 'final',
      'emitted', 'rejected', 'gate-below-threshold', 'gate-max-items', 'duplicate', 'scope', 'quality',
    ]);
    const db = openHippoDb(store(proj));
    let cells: string[];
    try {
      // SAFETY: SELECT * rows are column-name to cell maps; only string cells are kept.
      const rows = [
        ...db.prepare('SELECT * FROM delivery_events').all(),
        ...db.prepare('SELECT * FROM delivery_candidates').all(),
      ] as Array<{ [column: string]: string | number | null }>;
      cells = rows.flatMap((r) => Object.values(r)).filter((v): v is string => typeof v === 'string');
    } finally {
      closeHippoDb(db);
    }
    expect(cells.length).toBeGreaterThan(0);
    const odd = cells.filter((v) => !/^[0-9a-f]{16}$/.test(v) && !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && !ids.has(v) && !allowed.has(v));
    expect(odd).toEqual([]);
    const words = [PROMPT, ...seeded.map((m) => m.content)].flatMap((t) => {
      const w = t.split(/\s+/);
      return w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(' '));
    });
    expect(cells.filter((v) => words.some((p) => v.includes(p)))).toEqual([]);
  });
});
