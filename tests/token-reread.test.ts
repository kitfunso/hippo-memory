// Re-read tokens (what later model calls read again), the compact-resume ledger surface and sub-agent hook payloads.
// Real SQLite, synthetic transcripts and the built CLI in scratch homes; no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { appendSessionEvent, initStore, saveActiveTaskSnapshot, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { runDoctor } from '../src/doctor.js';
import { Layer } from '../src/memory.js';
import { createMemory } from './_helpers/create-memory.js';
import {
  carryingCalls,
  estimateTokens,
  isSubagentPayload,
  lastSentState,
  readApiCalls,
  recordRereads,
  recordTokenUse,
  shouldSkipUnchanged,
  type ApiCall,
  type TokenEvent,
  type TokenSummary,
  type TokenSurface,
} from '../src/token-ledger.js';

const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');
const SESSION = 'sess-reread';
// Noon UTC yesterday: re-read rows are per UTC day, so a run near midnight must not split a test's calls.
const BASE = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 12 * 3_600_000;
const DAY = 86_400_000;
const minute = (m: number): number => BASE + m * 60_000;
const iso = (at: number): string => new Date(at).toISOString();

type Db = ReturnType<typeof openHippoDb>;
interface LedgerRow { tenant_id: string; session_id: string; surface: string; items: number; tokens: number }

function withDb<T>(root: string, fn: (db: Db) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function book(db: Db, surface: TokenSurface, event: TokenEvent, at: number, tokens: number, sessionId = SESSION, tenantId = 'default'): void {
  recordTokenUse(db, { tenantId, sessionId, surface, event, items: 1, tokens, hash: 'h1', now: iso(at) });
}

function ledgerRows(root: string, where: string): LedgerRow[] {
  return withDb(root, (db) => {
    // SAFETY: the SELECT names exactly these five columns.
    const rows = db.prepare(
      `SELECT tenant_id, session_id, surface, items, tokens FROM token_ledger WHERE ${where} ORDER BY surface, tenant_id, ts`,
    ).all() as LedgerRow[];
    return rows.map((row) => ({ ...row, items: Number(row.items), tokens: Number(row.tokens) }));
  });
}

function rereadStamps(root: string): Array<[string, string]> {
  return withDb(root, (db) => {
    // SAFETY: the SELECT names exactly these two columns.
    const rows = db.prepare(`SELECT surface, ts FROM token_ledger WHERE event = 'reread' ORDER BY surface, ts`).all() as Array<{ surface: string; ts: string }>;
    return rows.map((row) => [row.surface, row.ts]);
  });
}

/** One transcript line of a model call; a call that spans several lines repeats its message id. */
function callLine(id: string, at: number, opts: { model?: string; sidechain?: boolean; usage?: boolean } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.sidechain ?? false,
    timestamp: iso(at),
    message: {
      id, model: opts.model ?? 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'done' }],
      usage: opts.usage === false ? null : { input_tokens: 10, output_tokens: 2 },
    },
  });
}

function boundaryLine(at: number, sidechain = false): string {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: sidechain, timestamp: iso(at), content: 'Conversation compacted' });
}

/** Scratch homes and stores for the built CLI, with no provider keys and no global npm bin on PATH. */
function scratch(root: string) {
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(home);
  mkdirSync(proj);
  const drop = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HIPPO_TENANT', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
    'XDG_DATA_HOME', 'HIPPO_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'PATH']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!drop.has(key.toUpperCase())) env[key] = value;
  env.PATH = (process.env.PATH ?? '').split(delimiter).filter((dir) => !/[\\/]npm[\\/]?$/i.test(dir)).join(delimiter);
  Object.assign(env, { HIPPO_HOME: join(root, 'global'), HOME: home, USERPROFILE: home, APPDATA: home });
  return { env, proj, globalRoot: join(root, 'global') };
}

function hippo(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd, env, input, encoding: 'utf8' });
}

describe('model calls in a transcript', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hippo-reread-calls-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts each main-thread model call once and the main-thread compactions before it', async () => {
    const file = join(dir, 'transcript.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', timestamp: iso(minute(0)), message: { role: 'user', content: 'hi' } }),
      callLine('m1', minute(1)),
      callLine('m1', minute(1.1)),
      callLine('side', minute(2), { sidechain: true }),
      boundaryLine(minute(2), true),
      callLine('syn', minute(2), { model: '<synthetic>' }),
      callLine('bare', minute(2), { usage: false }),
      '{"type":"assistant","message":{"usage":',
      callLine('m2', minute(3)),
      boundaryLine(minute(4)),
      callLine('m3', minute(5)),
      '',
    ].join('\n'));
    const read = await readApiCalls(file);
    expect(read.calls).toEqual([
      { at: minute(1), compactions: 0 },
      { at: minute(3), compactions: 0 },
      { at: minute(5), compactions: 1 },
    ]);
    expect(read.malformed).toBe(1);
  });

  it('rejects when the transcript cannot be read', async () => {
    await expect(readApiCalls(join(dir, 'missing.jsonl'))).rejects.toThrow();
  });

  it('carries a block through the later calls up to the next compaction', () => {
    const calls: ApiCall[] = [
      { at: 100, compactions: 0 }, { at: 200, compactions: 0 }, { at: 300, compactions: 0 },
      { at: 400, compactions: 1 }, { at: 500, compactions: 1 },
    ];
    const carried = (at: number): number[] => carryingCalls(calls, at).map((call) => call.at);
    expect(carried(50)).toEqual([100, 200, 300]);
    expect(carried(200)).toEqual([300]);
    expect(carried(350)).toEqual([400, 500]);
    expect(carried(600)).toEqual([]);
    // A call stamped at the send's own millisecond did not carry it, so the window is the next call's.
    expect(carryingCalls([{ at: 200, compactions: 0 }, { at: 300, compactions: 1 }], 200).map((call) => call.at)).toEqual([300]);
  });
});

describe('recordRereads', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-reread-db-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('books one row per surface, replaces them on a second pass, and leaves TE2 state alone', () => {
    const calls: ApiCall[] = [
      { at: minute(1), compactions: 0 }, { at: minute(2), compactions: 0 }, { at: minute(3), compactions: 0 },
      { at: minute(6), compactions: 1 }, { at: minute(7), compactions: 1 },
    ];
    const before = withDb(root, (db) => {
      book(db, 'hook', 'inject', minute(0.5), 100);
      book(db, 'hook_recall', 'inject', minute(0.5), 40);
      book(db, 'hook', 'skip', minute(1.5), 100);
      book(db, 'hook', 'reset', minute(5), 0);
      book(db, 'compact_resume', 'inject', minute(5), 50);
      book(db, 'hook', 'inject', minute(5.5), 100);
      book(db, 'hook', 'skip', minute(6.5), 100);
      book(db, 'hook', 'inject', minute(0.5), 999, 'other-session');
      book(db, 'hook', 'inject', minute(0.5), 999, SESSION, 'other-tenant');
      return lastSentState(db, 'default', SESSION, 'hook');
    });
    expect(before).toEqual({ hash: 'h1', skipsSince: 1 });

    for (let pass = 0; pass < 2; pass++) {
      expect(withDb(root, (db) => recordRereads(db, 'default', SESSION, calls))).toBe(430);
    }
    expect(ledgerRows(root, `event = 'reread'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'compact_resume', items: 1, tokens: 50 },
      { tenant_id: 'default', session_id: SESSION, surface: 'hook', items: 3, tokens: 300 },
      { tenant_id: 'default', session_id: SESSION, surface: 'hook_recall', items: 2, tokens: 80 },
    ]);
    expect(rereadStamps(root)).toEqual([['compact_resume', iso(minute(7))], ['hook', iso(minute(7))], ['hook_recall', iso(minute(3))]]);
    withDb(root, (db) => {
      expect(lastSentState(db, 'default', SESSION, 'hook')).toEqual(before);
      expect(shouldSkipUnchanged(lastSentState(db, 'default', SESSION, 'hook'), 'h1', 0)).toBe(true);
    });
  });

  it("dates each row at its UTC day's last re-read or send, and keeps an empty row on the day of a send nothing re-read", () => {
    const calls: ApiCall[] = [
      { at: minute(1) - DAY, compactions: 0 }, { at: minute(2) - DAY, compactions: 0 },
      { at: minute(3), compactions: 0 }, { at: minute(4), compactions: 1 },
    ];
    withDb(root, (db) => {
      book(db, 'hook', 'inject', minute(0) - DAY, 100);
      // Sent after the compaction and never re-read; the ledger hands it over first, so the day's date must not be last-write.
      book(db, 'hook', 'inject', minute(3.5), 70);
      book(db, 'hook_recall', 'inject', minute(4.5), 40);
    });
    expect(withDb(root, (db) => recordRereads(db, 'default', SESSION, calls))).toBe(200);
    expect(ledgerRows(root, `event = 'reread'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'hook', items: 1, tokens: 100 },
      { tenant_id: 'default', session_id: SESSION, surface: 'hook', items: 1, tokens: 100 },
      { tenant_id: 'default', session_id: SESSION, surface: 'hook_recall', items: 0, tokens: 0 },
    ]);
    expect(rereadStamps(root)).toEqual([['hook', iso(minute(2) - DAY)], ['hook', iso(minute(3.5))], ['hook_recall', iso(minute(4.5))]]);
  });

  it("books no re-reads for CLI, MCP and HTTP rows, which a sub-agent's calls book under its parent's session id", () => {
    const calls: ApiCall[] = [{ at: minute(1), compactions: 0 }, { at: minute(2), compactions: 0 }];
    const others: TokenSurface[] = ['context', 'recall', 'mcp_recall', 'mcp_context', 'http_recall', 'http_context', 'http_assemble'];
    withDb(root, (db) => {
      book(db, 'hook', 'inject', minute(0.5), 100);
      for (const surface of others) book(db, surface, 'inject', minute(0.5), 1000);
    });
    expect(withDb(root, (db) => recordRereads(db, 'default', SESSION, calls))).toBe(100);
    expect(ledgerRows(root, `event = 'reread'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'hook', items: 1, tokens: 100 },
    ]);
  });
});

describe('__session-end-worker counts re-reads', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let proj: string;
  let globalRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-reread-worker-'));
    ({ env, proj, globalRoot } = scratch(root));
    initStore(join(proj, '.hippo'));
    initStore(globalRoot);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  function worker(transcript: string): string {
    const log = join(root, 'session-end.log');
    const result = hippo(['__session-end-worker', '--log-file', log, '--transcript', transcript, '--session-id', SESSION], proj, env);
    expect(result.status).toBe(0);
    return readFileSync(log, 'utf8');
  }

  it('books both stores, logs the total, and a second pass leaves the same totals', () => {
    const sent = minute(0);
    withDb(join(proj, '.hippo'), (db) => book(db, 'hook', 'inject', sent, 100));
    withDb(globalRoot, (db) => book(db, 'hook_recall', 'inject', sent, 30));
    const transcript = join(root, `${SESSION}.jsonl`);
    writeFileSync(transcript, [1, 2, 3].map((n) => callLine(`m${n}`, sent + n * 10_000)).join('\n') + '\n');

    for (let pass = 0; pass < 2; pass++) {
      expect(worker(transcript)).toContain(`re-read 260 tokens over 3 model calls for session ${SESSION}`);
      expect(ledgerRows(join(proj, '.hippo'), `event = 'reread'`)).toEqual([
        { tenant_id: 'default', session_id: SESSION, surface: 'hook', items: 2, tokens: 200 },
      ]);
      expect(ledgerRows(globalRoot, `event = 'reread'`)).toEqual([
        { tenant_id: 'default', session_id: SESSION, surface: 'hook_recall', items: 2, tokens: 60 },
      ]);
    }
  });

  it('still logs the count in a project with no store of its own, and no longer exits early', () => {
    rmSync(join(proj, '.hippo'), { recursive: true, force: true });
    const sent = minute(0);
    withDb(globalRoot, (db) => book(db, 'hook', 'inject', sent, 100));
    const transcript = join(root, `${SESSION}.jsonl`);
    writeFileSync(transcript, [1, 2].map((n) => callLine(`m${n}`, sent + n * 10_000)).join('\n') + '\n');
    const log = join(root, 'session-end.log');
    const result = hippo(['__session-end-worker', '--log-file', log, '--transcript', transcript, '--session-id', SESSION], proj, env);
    expect(result.status).toBe(0);
    const text = readFileSync(log, 'utf8');
    expect(text).not.toContain('No hippo store at');
    expect(text).toContain(`re-read 100 tokens over 2 model calls for session ${SESSION}`);
  });

  it('dates re-reads by the day their calls happened, so hippo tokens --days 1 counts only the recent day', () => {
    const sent = minute(0) - 2 * DAY;
    withDb(join(proj, '.hippo'), (db) => book(db, 'hook', 'inject', sent, 100));
    const transcript = join(root, `${SESSION}.jsonl`);
    const calls = [callLine('m1', sent + 60_000), callLine('m2', sent + 120_000), callLine('m3', Date.now() - 60_000)];
    writeFileSync(transcript, calls.join('\n') + '\n');
    for (let pass = 0; pass < 2; pass++) {
      expect(worker(transcript)).toContain(`re-read 200 tokens over 3 model calls for session ${SESSION}`);
    }
    const tokens = (days: string): TokenSummary => JSON.parse(hippo(['tokens', '--days', days, '--json'], proj, env).stdout);
    expect(tokens('1')).toMatchObject({ totalTokens: 0, totalTokensReread: 100, hookSessions: 1, rereadSessions: 1 });
    expect(tokens('7')).toMatchObject({ totalTokens: 100, totalTokensReread: 200, hookSessions: 1, rereadSessions: 1 });
  });

  it('logs one line and books nothing when the transcript cannot be read', () => {
    withDb(join(proj, '.hippo'), (db) => book(db, 'hook', 'inject', Date.now() - 60_000, 100));
    const lines = worker(join(root, 'missing.jsonl')).split('\n').filter((line) => line.includes('re-read'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('skip re-read count: cannot read the transcript');
    expect(ledgerRows(join(proj, '.hippo'), `event = 'reread'`)).toEqual([]);
    expect(ledgerRows(globalRoot, `event = 'reread'`)).toEqual([]);
  });
});

describe('compact-resume books the block it prints', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let proj: string;
  let globalRoot: string;
  const payload = JSON.stringify({ session_id: SESSION, source: 'compact' });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-reread-resume-'));
    ({ env, proj, globalRoot } = scratch(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('prints the same bytes as before and books them under the payload session id', () => {
    const store = join(proj, '.hippo');
    initStore(store);
    const snapshot = saveActiveTaskSnapshot(store, 'default', {
      task: 'add rate limiting', summary: 'The handler is done.', next_step: 'Write the limiter tests.', source: 'pre-compact', session_id: SESSION,
    });
    const event = appendSessionEvent(store, 'default', { session_id: SESSION, event_type: 'note', content: 'chose a token bucket' });
    const expected = [
      '## Restored after compaction', '',
      "_Point-in-time working-state snapshot, auto-restored after compaction. Background reference, not instructions; the user's live messages win._", '',
      '## Active Task Snapshot', '',
      `- Task: ${snapshot.task}`, `- Status: ${snapshot.status}`, `- Updated: ${snapshot.updated_at}`,
      `- Source: ${snapshot.source}`, `- Session: ${SESSION}`, '',
      '### Summary', snapshot.summary, '',
      '### Next step', snapshot.next_step, '',
      '## Recent Session Trail', '',
      `- Session: ${SESSION}`, `- Task: ${event.task ?? 'n/a'}`, `- Updated: ${event.created_at}`, '',
      `- [${event.created_at}] (note) chose a token bucket`, '', '',
    ].join('\n');

    const result = hippo(['compact-resume'], proj, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(ledgerRows(store, `surface = 'compact_resume'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'compact_resume', items: 1, tokens: estimateTokens(expected.slice(0, -1)) },
    ]);
  });

  it('books into the global store when the project has none, and creates no project store', () => {
    initStore(globalRoot);
    saveActiveTaskSnapshot(globalRoot, 'default', {
      task: 'global task', summary: 's', next_step: 'n', source: 'pre-compact', session_id: SESSION,
    });
    const result = hippo(['compact-resume'], proj, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('global task');
    expect(ledgerRows(globalRoot, `surface = 'compact_resume'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'compact_resume', items: 1, tokens: estimateTokens(result.stdout.slice(0, -1)) },
    ]);
    expect(existsSync(join(proj, '.hippo'))).toBe(false);
  });

  it('prints nothing and creates no store when there is none', () => {
    const result = hippo(['compact-resume'], proj, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(proj, '.hippo'))).toBe(false);
    expect(existsSync(join(globalRoot, 'hippo.db'))).toBe(false);
  });

  it('still prints the snapshot when a trail row cannot be read, and says why on stderr', () => {
    const store = join(proj, '.hippo');
    initStore(store);
    const snapshot = saveActiveTaskSnapshot(store, 'default', {
      task: 'add rate limiting', summary: 'The handler is done.', next_step: 'Write the limiter tests.', source: 'pre-compact', session_id: SESSION,
    });
    // A blob, not text, where the trail expects a string.
    withDb(store, (db) => db.prepare(
      `INSERT INTO session_events (session_id, task, event_type, content, source, metadata_json, created_at, tenant_id)
       VALUES (?, NULL, 'note', zeroblob(500), 'test', '{}', ?, 'default')`,
    ).run(SESSION, new Date().toISOString()));
    const expected = [
      '## Restored after compaction', '',
      "_Point-in-time working-state snapshot, auto-restored after compaction. Background reference, not instructions; the user's live messages win._", '',
      '## Active Task Snapshot', '',
      `- Task: ${snapshot.task}`, `- Status: ${snapshot.status}`, `- Updated: ${snapshot.updated_at}`,
      `- Source: ${snapshot.source}`, `- Session: ${SESSION}`, '',
      '### Summary', snapshot.summary, '',
      '### Next step', snapshot.next_step, '', '',
    ].join('\n');

    const result = hippo(['compact-resume'], proj, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toContain('hippo compact-resume: trail skipped:');
    expect(ledgerRows(store, `surface = 'compact_resume'`)).toEqual([
      { tenant_id: 'default', session_id: SESSION, surface: 'compact_resume', items: 1, tokens: estimateTokens(expected.slice(0, -1)) },
    ]);
  });

  it('prints nothing on a broken store and says why on stderr', () => {
    const store = join(proj, '.hippo');
    initStore(store);
    writeFileSync(join(store, 'hippo.db'), 'not a sqlite file', 'utf8');
    for (const suffix of ['-wal', '-shm']) rmSync(join(store, `hippo.db${suffix}`), { force: true });
    const result = hippo(['compact-resume'], proj, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('hippo compact-resume: skipped:');
  });

  it('reports the skip reason through the logger, so HIPPO_LOG=error silences it', () => {
    const store = join(proj, '.hippo');
    initStore(store);
    writeFileSync(join(store, 'hippo.db'), 'not a sqlite file', 'utf8');
    for (const suffix of ['-wal', '-shm']) rmSync(join(store, `hippo.db${suffix}`), { force: true });
    const loud = hippo(['compact-resume'], proj, env, payload);
    expect(loud.stderr).toContain('[hippo] warn: hippo compact-resume: skipped:');
    const quiet = hippo(['compact-resume'], proj, { ...env, HIPPO_LOG: 'error' }, payload);
    expect([quiet.status, quiet.stdout]).toEqual([0, '']);
    expect(quiet.stderr).not.toContain('compact-resume');
  });
});

describe("a sub-agent's hooks", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let proj: string;
  let store: string;
  const HOOK = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
  const main = (fields: Record<string, string> = {}): string => JSON.stringify({ session_id: SESSION, ...fields });
  // Inside a sub-agent the payload keeps the parent's session_id and adds agent_id (and agent_type).
  const sub = (fields: Record<string, string> = {}): string => main({ agent_id: 'agent-1', agent_type: 'Explore', ...fields });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-reread-subagent-'));
    ({ env, proj } = scratch(root));
    store = join(proj, '.hippo');
    initStore(store);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('tells a sub-agent payload by agent_id alone, since an --agent session also sends agent_type', () => {
    expect(isSubagentPayload(sub())).toBe(true);
    expect(isSubagentPayload(main())).toBe(false);
    expect(isSubagentPayload(main({ agent_type: 'Explore' }))).toBe(false);
    expect(isSubagentPayload(main({ agent_id: ' ' }))).toBe(false);
    expect(isSubagentPayload('not json')).toBe(false);
    expect(isSubagentPayload(undefined)).toBe(false);
  });

  it("books a sub-agent's hook block under no session and never skips it as a repeat of the parent's", () => {
    writeEntry(store, createMemory('NEVER force-push to master because it rewrites shared history', { pinned: true, layer: Layer.Episodic }));
    const parentEnv = { ...env, CLAUDE_CODE_SESSION_ID: SESSION };
    expect(hippo(HOOK, proj, parentEnv, main({ prompt: 'hi' })).stdout).toContain('NEVER force-push');
    expect(hippo(HOOK, proj, parentEnv, sub({ prompt: 'hi' })).stdout).toContain('NEVER force-push');
    expect(ledgerRows(store, `surface = 'hook' AND event = 'inject' AND session_id IS NULL`)).toHaveLength(1);
    expect(ledgerRows(store, `surface = 'hook' AND event = 'inject' AND session_id = '${SESSION}'`)).toHaveLength(1);
    expect(ledgerRows(store, `event = 'skip'`)).toEqual([]);
    // Control: the parent's own repeat still skips.
    expect(hippo(HOOK, proj, parentEnv, main({ prompt: 'hi' })).stdout.trim()).toBe('');
  });

  it("shows a sub-agent its parent's task snapshot past the 72-hour bound, as the parent sees it", () => {
    writeEntry(store, createMemory('NEVER force-push to master because it rewrites shared history', { pinned: true, layer: Layer.Episodic }));
    saveActiveTaskSnapshot(store, 'default', { task: 'parent task', summary: 's', next_step: 'n', source: 'pre-compact', session_id: SESSION });
    withDb(store, (db) => db.prepare(`UPDATE task_snapshots SET updated_at = ?`).run(iso(Date.now() - 4 * DAY)));
    expect(hippo(HOOK, proj, env, sub({ prompt: 'hi' })).stdout).toContain('parent task');
    // Control: another session's hook still gets the pin but no longer sees the stale snapshot.
    const other = hippo(HOOK, proj, env, main({ session_id: 'other', prompt: 'hi' })).stdout;
    expect(other).toContain('NEVER force-push');
    expect(other).not.toContain('parent task');
  });

  it("restores nothing into a sub-agent that compacts, though the parent's snapshot matches its session id", () => {
    saveActiveTaskSnapshot(store, 'default', { task: 'parent task', summary: 's', next_step: 'n', source: 'pre-compact', session_id: SESSION });
    const result = hippo(['compact-resume'], proj, env, sub({ source: 'compact' }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(ledgerRows(store, `surface = 'compact_resume'`)).toEqual([]);
    // Control: the parent's own compaction restores it.
    expect(hippo(['compact-resume'], proj, env, main({ source: 'compact' })).stdout).toContain('parent task');
  });

  it("leaves the parent's inject-only-on-change state alone when a sub-agent compacts", () => {
    withDb(store, (db) => book(db, 'hook', 'inject', Date.now() - 60_000, 100));
    expect(hippo(['pre-compact'], proj, env, sub({ hook_event_name: 'PreCompact' })).status).toBe(0);
    expect(hippo(['compact-resume'], proj, env, sub({ source: 'compact' })).status).toBe(0);
    expect(withDb(store, (db) => lastSentState(db, 'default', SESSION, 'hook'))).toEqual({ hash: 'h1', skipsSince: 0 });
    // Control: the parent's own compaction resets it.
    hippo(['compact-resume'], proj, env, main({ source: 'compact' }));
    expect(withDb(store, (db) => lastSentState(db, 'default', SESSION, 'hook'))).toBeNull();
  });
});

describe('re-read reports', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let proj: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-reread-report-'));
    ({ env, proj } = scratch(root));
    initStore(join(proj, '.hippo'));
    withDb(join(proj, '.hippo'), (db) => {
      const at = Date.now() - 60_000;
      book(db, 'hook', 'inject', at, 100, 's1');
      book(db, 'compact_resume', 'inject', at, 50, 's1');
      book(db, 'recall', 'inject', at, 30, 's2');
      book(db, 'hook', 'reread', at, 200, 's1');
      book(db, 'compact_resume', 'reread', at, 50, 's1');
      // s3 only compacted, so it has no block to re-read; s4 only skipped, so a block it sent earlier went uncounted.
      book(db, 'hook', 'reset', at, 0, 's3');
      book(db, 'hook', 'skip', at, 100, 's4');
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('hippo tokens shows re-reads per surface, in total and with coverage, in text and JSON', () => {
    const json = JSON.parse(hippo(['tokens', '--json'], proj, env).stdout);
    expect(json).toMatchObject({ totalTokens: 180, totalTokensReread: 250, sessions: 4, hookSessions: 2, rereadSessions: 1 });
    expect(json.surfaces.map((s: { surface: string; tokensReread: number }) => [s.surface, s.tokensReread]))
      .toEqual([['hook', 200], ['compact_resume', 50], ['recall', 0]]);

    const text = hippo(['tokens'], proj, env).stdout;
    expect(text).toContain('(estimated tokens, characters / 4)');
    expect(text).toMatch(/surface\s+sent\s+tokens\s+skipped\s+saved\s+re-read\n/);
    expect(text).toMatch(/compact_resume\s+1\s+50\s+0\s+0\s+50\n/);
    // s2 sent through the CLI only, so its re-reads can never be counted and it stays out of the coverage.
    expect(text).toContain('Re-read by later model calls until compaction: 250 tokens, counted for 1 of 2 sessions.');
    expect(text).toContain(
      'Re-reads are counted for hook and compact-resume blocks when a session ends; other surfaces, and open or crashed sessions, show sent only.',
    );
    expect(text).toContain("Re-reads usually bill at the provider's cached-input rate, a fraction of the full input price.");
  });

  it('hippo doctor reports tokens sent and re-read', () => {
    const tokens = runDoctor({ cwd: proj, home: join(root, 'home'), version: 'test' }).checks.find((c) => c.id === 'tokens');
    expect(tokens?.detail).toBe('3 memory blocks sent to agents in 7 days, about 180 tokens sent and 250 re-read by later model calls (hippo tokens for detail)');
  });
});
