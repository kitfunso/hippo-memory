// Pins what a recall records once it has ranked, on HTTP (GET /v1/memories) and the CLI (`hippo recall`): the audit rows,
// the recalled counter, the token ledger row and the session ring. The bookkeeping may move; none of this may change with it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { appendSessionEvent, saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { handleRecall } from '../src/cli/recall.js';
import { resetSessionRings } from '../src/api/recall-record.js';
import { serve, __resetSessionRecallHistoryHttp, type ServerHandle } from '../src/server.js';
import type { RecallResult } from '../src/api/index.js';
import { estimateTokens } from '../src/util/token-text.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { runInProcess } from './_helpers/run-in-process.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, normalise, rowsOf, seedTemplates, SESSION, statsMirror, TENANT, type Store, type Templates,
} from './_helpers/recall-golden-seed.js';
import type { CliFlags } from '../src/cli/flag-values.js';

type Surface = 'http' | 'cli';
const SURFACES: readonly Surface[] = ['http', 'cli'];
const HOST_SESSION = 'host-agent-session';

interface RecallCall { query: string; session?: string; http?: Record<string, string>; cli?: CliFlags }

/** What the caller got back: the HTTP status, header and body, or the CLI exit status and streams; `hint` is the memory it anchored on. */
interface Reply { status: number; cacheControl: string | null; body: unknown; stderr: string; hint: string | null }

interface LedgerRow { tenant_id: string; session_id: string | null; surface: string; event: string; items: number; tokens: number }

let templates: Templates;
let launchFolder: string;

async function viaHttp(handle: ServerHandle, c: RecallCall): Promise<Reply> {
  const params = new URLSearchParams({ q: c.query });
  if (c.session) params.set('session_id', c.session);
  for (const [k, v] of Object.entries(c.http ?? {})) params.set(k, v);
  const res = await fetch(`${handle.url}/v1/memories?${params.toString()}`);
  // SAFETY: /v1/memories answers a serialised RecallResult on 200 and { error } otherwise, and only the optional hint is read here.
  const body = (await res.json()) as Partial<RecallResult>;
  return { status: res.status, cacheControl: res.headers.get('cache-control'), body, stderr: '', hint: body.anchoringHint?.memoryId ?? null };
}

async function viaCli(s: Store, c: RecallCall): Promise<Reply> {
  const flags: CliFlags = { ...c.cli };
  if (c.session) flags['session-id'] = c.session;
  const out = await runInProcess(() => handleRecall({ hippoRoot: s.root, tenantId: TENANT, args: [c.query], flags }));
  return { status: out.status, cacheControl: null, body: out.stdout, stderr: out.stderr, hint: /\[anchored_on: ([^\]]+)\]/.exec(out.stdout)?.[1] ?? null };
}

/** The calls in order on one surface; HTTP keeps one server up for all of them, as a long-lived client sees it. */
async function recallOn(surface: Surface, s: Store, calls: readonly RecallCall[], between?: (done: number) => void): Promise<Reply[]> {
  const handle = surface === 'http' ? await serve({ hippoRoot: s.root, port: 0 }) : null;
  try {
    const out: Reply[] = [];
    for (const c of calls) {
      out.push(handle ? await viaHttp(handle, c) : await viaCli(s, c));
      between?.(out.length);
    }
    return out;
  } finally {
    await handle?.stop();
  }
}

/** Every row a recall writes plus the stats.json mirror the counter bump rewrites. */
function recorded(s: Store) {
  return { ...rowsOf(s.root), mirror: statsMirror(s.root) };
}

function ledgerOf(s: Store): LedgerRow[] {
  // SAFETY: rowsOf selects exactly the six token_ledger columns LedgerRow declares.
  return rowsOf(s.root).ledger as LedgerRow[];
}

function totalRecalled(s: Store): number {
  // SAFETY: rowsOf selects the key and value columns of meta.
  const stats = rowsOf(s.root).stats as { key: string; value: string }[];
  return Number(stats.find((row) => row.key === 'total_recalled')?.value ?? 0);
}

function refuseRecallAudit(root: string, on: boolean): void {
  const db = openHippoDb(root);
  try {
    db.exec(on
      ? "CREATE TRIGGER refuse_recall_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'recall' BEGIN SELECT RAISE(ABORT, 'recall audit refused'); END"
      : 'DROP TRIGGER refuse_recall_audit');
  } finally {
    closeHippoDb(db);
  }
}

/** The continuity a recall can return: a live snapshot, its handoff and one session event. */
function seedContinuity(root: string): void {
  saveActiveTaskSnapshot(root, TENANT, { task: 'ship the eu cluster', summary: 'cutover planned', next_step: 'run the canary', session_id: SESSION });
  saveSessionHandoff(root, TENANT, { version: 1, sessionId: SESSION, summary: 'handoff after the canary', nextAction: 'promote it' });
  appendSessionEvent(root, TENANT, { session_id: SESSION, event_type: 'note', content: 'canary passed' });
}

/** A store with no memory in it and no global store beside it. */
function emptyStore(): Store {
  const home = mkdtempSync(join(tmpdir(), 'hippo-records-empty-'));
  const root = join(home, 'store');
  initStore(root);
  vi.stubEnv('HIPPO_HOME', join(home, 'global'));
  return { home, root, globalRoot: join(home, 'global'), goalId: 'no-goal' };
}

/** Runs `fn` with the store's folder as the working folder, so nothing resolves a store from the repo checkout. */
async function onStore<T>(s: Store, fn: (s: Store) => Promise<T>): Promise<T> {
  process.chdir(s.home);
  try {
    return normalise(await fn(s), s);
  } finally {
    process.chdir(launchFolder);
    rmSync(s.home, { recursive: true, force: true });
  }
}

const onSeeded = <T>(fn: (s: Store) => Promise<T>): Promise<T> => onStore(freshStore(templates, 'local'), fn);

beforeAll(() => {
  launchFolder = process.cwd();
  templates = seedTemplates(seedContinuity);
});

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

describe('what a recall records, HTTP and CLI', () => {
  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    _resetAblationCacheForTests();
    resetSessionRings('cli');
    __resetSessionRecallHistoryHttp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  it.each(SURFACES)('%s: a recall with no session id', async (surface) => {
    const got = await onSeeded(async (s) => {
      const [reply] = await recallOn(surface, s, [{ query: 'deploy' }]);
      return { reply, rows: recorded(s), ledger: ledgerOf(s), recalled: totalRecalled(s) };
    });
    expect(got.reply!.status).toBe(surface === 'http' ? 200 : 0);
    expect(got.ledger).toHaveLength(1);
    expect(got.ledger[0]).toMatchObject({ tenant_id: TENANT, session_id: null, surface: surface === 'http' ? 'http_recall' : 'recall', event: 'inject' });
    expect(got.recalled).toBe(got.ledger[0]!.items);
    expect(got.recalled).toBeGreaterThan(0);
    expect({ ...got, ledger: undefined }).toMatchSnapshot();
  });

  it.each(SURFACES)('%s: two recalls in one session, the second carries the hint the first fed', async (surface) => {
    const got = await onSeeded(async (s) => {
      const call: RecallCall = { query: 'deploy', session: SESSION };
      const replies = await recallOn(surface, s, [call, call]);
      return { replies, rows: recorded(s), ledger: ledgerOf(s), recalled: totalRecalled(s) };
    });
    expect(got.replies.map((r) => r.hint === null)).toEqual([true, false]);
    expect(got.ledger).toHaveLength(2);
    // HTTP books the recall's session; the CLI books the host agent's, and none is set here.
    expect(got.ledger.map((row) => row.session_id)).toEqual(surface === 'http' ? [SESSION, SESSION] : [null, null]);
    expect(got.recalled).toBe(got.ledger[0]!.items + got.ledger[1]!.items);
    expect({ ...got, ledger: undefined }).toMatchSnapshot();
  });

  it('cli: the ledger row names the host agent session while the ring follows --session-id', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', HOST_SESSION);
    const got = await onSeeded(async (s) => {
      const call: RecallCall = { query: 'deploy', session: SESSION };
      const replies = await recallOn('cli', s, [call, call]);
      return { hints: replies.map((r) => r.hint), ledger: ledgerOf(s), traces: rowsOf(s.root).traces };
    });
    expect(got.hints[0]).toBeNull();
    expect(got.hints[1]).not.toBeNull();
    expect(got.ledger.map((row) => [row.surface, row.session_id])).toEqual([['recall', HOST_SESSION], ['recall', HOST_SESSION]]);
    expect({ ...got, ledger: undefined }).toMatchSnapshot();
  });

  it.each(SURFACES)('%s: a recall with continuity', async (surface) => {
    const got = await onSeeded(async (s) => {
      const [reply] = await recallOn(surface, s, [{ query: 'deploy', http: { include_continuity: 'true' }, cli: { continuity: true } }]);
      // Priced before the times in the printed block are normalised; console.log adds the one newline the estimate leaves out.
      const printed = surface === 'cli' ? estimateTokens(String(reply!.body).replace(/\n$/, '')) : null;
      return { reply, printed, rows: recorded(s), ledger: ledgerOf(s), recalled: totalRecalled(s) };
    });
    expect(got.ledger).toHaveLength(1);
    if (surface === 'http') {
      // SAFETY: a 200 from /v1/memories is a serialised RecallResult.
      const body = got.reply!.body as RecallResult;
      expect(got.reply!.cacheControl).toBe('no-store');
      expect(body.continuityTokens).toBeGreaterThan(0);
      expect(got.ledger[0]).toMatchObject({ surface: 'http_recall', items: body.results.length, tokens: body.tokens + (body.continuityTokens ?? 0) });
    } else {
      // The CLI books the block it printed.
      expect(got.ledger[0]).toMatchObject({ surface: 'recall', tokens: got.printed });
      expect(String(got.reply!.body)).toContain('ship the eu cluster');
    }
    expect({ ...got, ledger: undefined }).toMatchSnapshot();
  });

  it.each(SURFACES)('%s: a recall that fails validation records nothing and feeds no ring', async (surface) => {
    const bad: RecallCall = { query: 'deploy', session: SESSION, http: { limit: '-5' }, cli: { layer: 'no-such-layer' } };
    const good: RecallCall = { query: 'deploy', session: SESSION };
    const got = await onSeeded(async (s) => {
      const before = recorded(s);
      const [failed] = await recallOn(surface, s, [bad]);
      const after = recorded(s);
      const later = await recallOn(surface, s, [good, good]);
      return { failed, before, after, laterHints: later.map((r) => r.hint) };
    });
    expect(got.failed!.status).toBe(surface === 'http' ? 400 : 1);
    // The CLI's ranking stages ran before the bad flag stopped it, so the goal log rows they earned stay; HTTP wrote nothing at all.
    if (surface === 'http') expect(got.after).toEqual(got.before);
    expect({ ...got.after, goalRecallLog: [] }).toEqual({ ...got.before, goalRecallLog: [] });
    // Had the failed call reached the ring, the first good recall would read as a repeat.
    expect(got.laterHints[0]).toBeNull();
    expect(got.laterHints[1]).not.toBeNull();
    expect({ failed: got.failed, laterHints: got.laterHints }).toMatchSnapshot();
  });

  it('http: a recall the store refuses to audit answers 500, records nothing and feeds no ring', async () => {
    const call: RecallCall = { query: 'deploy', session: SESSION };
    const got = await onSeeded(async (s) => {
      const before = recorded(s);
      let after = before;
      refuseRecallAudit(s.root, true);
      const replies = await recallOn('http', s, [call, call, call], (done) => {
        if (done !== 1) return;
        after = recorded(s);
        refuseRecallAudit(s.root, false);
      });
      return { statuses: replies.map((r) => r.status), hints: replies.map((r) => r.hint), before, after };
    });
    expect(got.statuses).toEqual([500, 200, 200]);
    expect(got.after).toEqual(got.before);
    expect(got.hints[1]).toBeNull();
    expect(got.hints[2]).not.toBeNull();
  });

  it('http: a refused recall with no session leaves no anchor-skipped row', async () => {
    const got = await onSeeded(async (s) => {
      const before = recorded(s);
      refuseRecallAudit(s.root, true);
      const [reply] = await recallOn('http', s, [{ query: 'deploy' }]);
      return { status: reply!.status, before, after: recorded(s) };
    });
    expect(got.status).toBe(500);
    expect(got.after).toEqual(got.before);
  });

  it('cli: a recall the store refuses to audit still prints, books its tokens and feeds the ring, and counts nothing', async () => {
    const call: RecallCall = { query: 'deploy', session: SESSION };
    const got = await onSeeded(async (s) => {
      const before = recorded(s);
      let after = before;
      refuseRecallAudit(s.root, true);
      const replies = await recallOn('cli', s, [call, call], (done) => {
        if (done !== 1) return;
        after = recorded(s);
        refuseRecallAudit(s.root, false);
      });
      return { replies, before, after };
    });
    expect(got.replies[0]!.status).toBe(0);
    expect(got.replies[0]!.stderr).toContain('audit write failed');
    expect({ ...got.after, ledger: [] }).toEqual({ ...got.before, ledger: [] });
    expect(got.after.ledger).toHaveLength(got.before.ledger.length + 1);
    expect(got.replies[1]!.hint).not.toBeNull();
  });

  it.each(SURFACES)('%s: a recall that finds nothing', async (surface) => {
    const got = await onStore(emptyStore(), async (s) => {
      // Removed first, so the file is back only if this recall went to the stats write.
      rmSync(join(s.root, 'stats.json'), { force: true });
      const [reply] = await recallOn(surface, s, [{ query: 'deploy' }]);
      return { reply, rows: recorded(s), ledger: ledgerOf(s), recalled: totalRecalled(s) };
    });
    expect(got.recalled).toBe(0);
    expect(got.ledger).toHaveLength(1);
    expect(got.ledger[0]!.items).toBe(0);
    // HTTP sends an empty count to the stats write, which rewrites the mirror; the CLI skips the write for an empty list.
    expect(got.rows.mirror === null).toBe(surface === 'cli');
    expect({ ...got, ledger: undefined }).toMatchSnapshot();
  });
});
