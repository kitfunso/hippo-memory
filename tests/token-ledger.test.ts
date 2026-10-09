/**
 * Token ledger (ROADMAP TE0), cache-stable hook rendering (TE1) and
 * inject-only-on-change for the per-prompt hook (TE2).
 *
 * Real SQLite, the built CLI, a real HTTP server on port 0. No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { Layer } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import {
  recordTokenUse,
  lastSentState,
  shouldSkipUnchanged,
  summarizeTokenUse,
  hookPayloadSessionId,
} from '../src/store/token-ledger.js';
import { blockHash } from '../src/util/token-text.js';
import { serve, type ServerHandle } from '../src/server.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { hippoOut } from './_helpers/spawn-hippo.js';

function withDb<T>(root: string, fn: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

describe('token ledger helpers', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-ledger-'));
    initStore(home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('tracks the last injected block per session and surface, and resets', () => {
    withDb(home, (db) => {
      expect(lastSentState(db, 'default', 's1', 'hook')).toBeNull();
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'inject', items: 2, tokens: 100, hash: 'aaa' });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'skip', items: 2, tokens: 100, hash: 'aaa' });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's2', surface: 'hook', event: 'inject', items: 1, tokens: 40, hash: 'bbb' });
      expect(lastSentState(db, 'default', 's1', 'hook')).toEqual({ hash: 'aaa', skipsSince: 1 });
      expect(lastSentState(db, 'default', 's1', 'context')).toBeNull();
      expect(lastSentState(db, 'other', 's1', 'hook')).toBeNull();
      expect(lastSentState(db, 'default', null, 'hook')).toBeNull();
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'reset', items: 0, tokens: 0 });
      expect(lastSentState(db, 'default', 's1', 'hook')).toBeNull();
    });
  });

  it('skips an unchanged block until refreshTurns consecutive skips', () => {
    expect(shouldSkipUnchanged(null, 'h', 10)).toBe(false);
    expect(shouldSkipUnchanged({ hash: 'x', skipsSince: 0 }, 'h', 10)).toBe(false);
    expect(shouldSkipUnchanged({ hash: 'h', skipsSince: 0 }, 'h', 10)).toBe(true);
    expect(shouldSkipUnchanged({ hash: 'h', skipsSince: 9 }, 'h', 10)).toBe(true);
    expect(shouldSkipUnchanged({ hash: 'h', skipsSince: 10 }, 'h', 10)).toBe(false);
    expect(shouldSkipUnchanged({ hash: 'h', skipsSince: 500 }, 'h', 0)).toBe(true);
  });

  it('summarizes sent and skipped tokens per surface and prunes old rows', () => {
    withDb(home, (db) => {
      const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
      recordTokenUse(db, { tenantId: 'default', sessionId: 'old', surface: 'recall', event: 'inject', items: 1, tokens: 999, now: old });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'inject', items: 2, tokens: 100, hash: 'a' });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'skip', items: 2, tokens: 100, hash: 'a' });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's1', surface: 'hook', event: 'skip', items: 2, tokens: 100, hash: 'a' });
      recordTokenUse(db, { tenantId: 'default', sessionId: 's2', surface: 'recall', event: 'inject', items: 3, tokens: 300 });
      recordTokenUse(db, { tenantId: 'other', surface: 'recall', event: 'inject', items: 3, tokens: 7777 });

      // SAFETY: COUNT(*) aggregate row.
      const oldRows = db.prepare(`SELECT COUNT(*) AS n FROM token_ledger WHERE session_id = 'old'`).get() as { n: number };
      expect(Number(oldRows.n)).toBe(0);

      const since = new Date(Date.now() - 86_400_000).toISOString();
      const summary = summarizeTokenUse(db, 'default', since);
      expect(summary.surfaces.map((s) => s.surface)).toEqual(['hook', 'recall']);
      const hook = summary.surfaces[0]!;
      expect(hook).toMatchObject({ injected: 1, tokens: 100, skipped: 2, tokensAvoided: 200, sessions: 1 });
      expect(summary.totalTokens).toBe(400);
      expect(summary.totalTokensAvoided).toBe(200);
      expect(summary.meanTokensPerSession).toBe(200);
    });
  });

  it('reads the session id from a hook payload', () => {
    expect(hookPayloadSessionId(JSON.stringify({ session_id: 'abc' }))).toBe('abc');
    expect(hookPayloadSessionId(JSON.stringify({ session_id: 'abc', source: 'startup' }), 'compact')).toBeNull();
    expect(hookPayloadSessionId(JSON.stringify({ session_id: 'abc', source: 'compact' }), 'compact')).toBe('abc');
    expect(hookPayloadSessionId('not json')).toBeNull();
    expect(hookPayloadSessionId(JSON.stringify({ session_id: '  ' }))).toBeNull();
    expect(hookPayloadSessionId(JSON.stringify(['x']))).toBeNull();
    expect(hookPayloadSessionId(undefined)).toBeNull();
    expect(blockHash('same')).toBe(blockHash('same'));
    expect(blockHash('same')).not.toBe(blockHash('diff'));
  });
});

describe('per-prompt hook: stable rendering and inject only on change', () => {
  let tmpDir: string;
  let hippoDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hippo-hook-dedup-'));
    hippoDir = join(tmpDir, '.hippo');
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('NEVER force-push to master because it rewrites shared history', { pinned: true, layer: Layer.Episodic }));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function run(args: string[], stdin = ''): string {
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: join(tmpDir, 'global') };
    delete env.HIPPO_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    return hippoOut(args, { env, cwd: tmpDir, input: stdin });
  }
  const HOOK = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
  const payload = (sessionId: string): string => JSON.stringify({ session_id: sessionId, prompt: 'hi' });

  it('renders without the live strength percentage', () => {
    const out = run(HOOK, payload('s1'));
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(text).toContain('NEVER force-push to master');
    expect(text).not.toMatch(/\(\d+%\)/);
  });

  it('sends the block once per session, skips repeats, and resends after compaction', () => {
    expect(run(HOOK, payload('s1'))).toContain('NEVER force-push');
    expect(run(HOOK, payload('s1')).trim()).toBe('');
    expect(run(HOOK, payload('s1')).trim()).toBe('');
    // A different session gets its own copy.
    expect(run(HOOK, payload('s2'))).toContain('NEVER force-push');
    // Compaction drops earlier injections: the next prompt sends again.
    run(['compact-resume'], JSON.stringify({ session_id: 's1', source: 'compact' }));
    expect(run(HOOK, payload('s1'))).toContain('NEVER force-push');
    expect(run(HOOK, payload('s1')).trim()).toBe('');

    const summary = JSON.parse(run(['tokens', '--json']));
    const hook = summary.surfaces.find((s: { surface: string }) => s.surface === 'hook');
    expect(hook.injected).toBe(3);
    expect(hook.skipped).toBe(3);
    expect(hook.tokensAvoided).toBeGreaterThan(0);
    expect(hook.tokensAvoided).toBe((hook.tokens / 3) * 3);
  });

  it('resends a changed block at once', () => {
    expect(run(HOOK, payload('s1'))).toContain('NEVER force-push');
    writeEntry(hippoDir, createMemory('ALWAYS run the migration dry-run before deploying', { pinned: true, layer: Layer.Episodic }));
    const out = run(HOOK, payload('s1'));
    expect(out).toContain('ALWAYS run the migration dry-run');
  });

  it('resends an unchanged block every refreshTurns skips', () => {
    writeFileSync(join(hippoDir, 'config.json'), JSON.stringify({ pinnedInject: { refreshTurns: 2 } }), 'utf8');
    const sent = [1, 2, 3, 4, 5, 6].map(() => run(HOOK, payload('s1')).trim() !== '');
    expect(sent).toEqual([true, false, false, true, false, false]);
  });

  it('always sends with skipUnchanged off, or without a payload session id', () => {
    expect(run(HOOK)).toContain('NEVER force-push');
    expect(run(HOOK)).toContain('NEVER force-push');
    writeFileSync(join(hippoDir, 'config.json'), JSON.stringify({ pinnedInject: { skipUnchanged: false } }), 'utf8');
    expect(run(HOOK, payload('s1'))).toContain('NEVER force-push');
    expect(run(HOOK, payload('s1'))).toContain('NEVER force-push');
  });

  it('keeps the strength percentage in the human markdown output', () => {
    expect(run(['context', '--pinned-only'])).toMatch(/\(\d+%\)/);
  });

  it('records CLI context and recall in the ledger', () => {
    run(['context', 'force-push']);
    run(['recall', 'force-push']);
    const summary = JSON.parse(run(['tokens', '--json']));
    const surfaces = summary.surfaces.map((s: { surface: string }) => s.surface);
    expect(surfaces).toContain('context');
    expect(surfaces).toContain('recall');
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(run(['tokens'])).toContain('Memory text handed to agents');
  });
});

describe('ledger on the HTTP and MCP surfaces', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-ledger-http-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-ledger-global-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    writeEntry(home, createMemory('the zanzibar gateway needs the legacy auth header', { layer: Layer.Episodic }));
  });
  afterEach(() => {
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  function surfaces(): Record<string, number> {
    return withDb(home, (db) => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      return Object.fromEntries(summarizeTokenUse(db, 'default', since).surfaces.map((s) => [s.surface, s.tokens]));
    });
  }

  it('records HTTP recall and context', async () => {
    const handle: ServerHandle = await serve({ hippoRoot: home, port: 0 });
    try {
      expect((await fetch(`${handle.url}/v1/memories?q=zanzibar`)).status).toBe(200);
      expect((await fetch(`${handle.url}/v1/context?q=zanzibar`)).status).toBe(200);
    } finally {
      await handle.stop();
    }
    const got = surfaces();
    expect(got.http_recall).toBeGreaterThan(0);
    expect(got.http_context).toBeGreaterThan(0);
  });

  it('records MCP recall', async () => {
    await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: 'zanzibar' } } },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp-test' },
    );
    expect(surfaces().mcp_recall).toBeGreaterThan(0);
  });
});
