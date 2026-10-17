import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getHippoRoot } from '../../src/core/project-identity.js';
import { saveActiveTaskSnapshot } from '../../src/store/sessions.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { handleMcpRequest, type McpResponse } from '../../src/mcp/server.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

// DF1 (docs/plans/2026-08-23-df1-snapshot-lifecycle.md) T2 tests: the two
// ambient surfaces (MCP recall block, CLI `hippo context`) reroute through
// the bounded read; explicit surfaces (`snapshot show`, `compact-resume`)
// must stay unaffected. Real SQLite / real built CLI, no mocks.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function backdateSnapshot(hippoRoot: string, id: number, isoTimestamp: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE id = ?`).run(isoTimestamp, id);
  } finally {
    closeHippoDb(db);
  }
}

describe('7. MCP hippo_context surface: backdated snapshot is bounded out', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('mcp-snapshot-freshness');
  });

  function callContext(): Promise<McpResponse | null> {
    return handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_context', arguments: {} },
      },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp', role: 'admin', hostAdmin: true, store: sqliteStore(home) },
    );
  }

  function extractText(res: McpResponse | null): string {
    // SAFETY: every hippo_context tool response in this suite carries a
    // single MCP text content block; the server's own formatter built it.
    const result = res?.result as { content?: Array<{ text?: string }> } | undefined;
    return result?.content?.[0]?.text ?? '';
  }

  it('a 7d-old active snapshot is absent from the MCP context block', async () => {
    const saved = saveActiveTaskSnapshot(home, 'default', {
      task: 'DF1 MCP staleness marker task',
      summary: 'must not appear over MCP once stale',
      next_step: 'n',
      session_id: 'sess-mcp-stale',
      source: 'test',
    });
    backdateSnapshot(home, saved.id, isoAgo(SEVEN_DAYS_MS));

    const text = extractText(await callContext());
    expect(text).not.toContain('DF1 MCP staleness marker task');
  });

  it('positive control: a fresh active snapshot IS present in the MCP context block', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'DF1 MCP fresh marker task',
      summary: 'must still appear over MCP',
      next_step: 'n',
      session_id: 'sess-mcp-fresh',
      source: 'test',
    });

    const text = extractText(await callContext());
    expect(text).toContain('DF1 MCP fresh marker task');
  });
});

// -----------------------------------------------------------------------
// Explicit surfaces (`snapshot show`, `compact-resume`) run through the
// real built CLI — same idiom as tests/core/pre-compact-e2e.test.ts.
// -----------------------------------------------------------------------

function withScratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df1-explicit-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  return { dir, env };
}

// In process unless `spawned`: the snapshot show case pins the CLI in a real child, the rest read bytes only.
async function runHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
  spawned = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return spawned ? hippoRun(args, { cwd, env, input }) : runCliAs(args, { cwd, env, input });
}

async function initHippo(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}

describe('8. explicit-surface regression: unaffected by the freshness bound (real CLI)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    await initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('`snapshot show` still returns a 7d-old backdated active row', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'stale but explicitly requested task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-explicit',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    const result = await runHippo(['snapshot', 'show', '--json'], dir, env, undefined, true);
    expect(result.status).toBe(0);
    // SAFETY: `hippo snapshot show --json` prints `{ snapshot }` via
    // JSON.stringify (cli.ts handleSnapshot) — the shape asserted here matches
    // that print call exactly.
    const parsed = JSON.parse(result.stdout) as { snapshot: { task: string } | null };
    expect(parsed.snapshot).not.toBeNull();
    expect(parsed.snapshot!.task).toBe('stale but explicitly requested task');
  });

  it('`compact-resume` no longer exempts a same-session 7d-old backdated row: the 15-min age gate has no owner exemption', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'stale same-session compact-resume task',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-compact-resume-stale',
      source: 'pre-compact',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    const payload = JSON.stringify({ session_id: 'sess-compact-resume-stale', source: 'compact' });
    const result = await runHippo(['compact-resume'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('stale same-session compact-resume task');
  });
});

// -----------------------------------------------------------------------
// Bonus (beyond the plan's 8 enumerated tests): end-to-end proof that the
// `hippo context` CLI dispatch itself -- isTTY-guarded stdin parse ->
// payload.session_id -> ContextOptions.currentSessionId -> api.getContext ->
// loadFreshActiveTaskSnapshot -- is wired correctly, not just the
// underlying store function in isolation (tests 1-5).
// -----------------------------------------------------------------------

describe('bonus: `hippo context` ambient CLI surface end-to-end', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    await initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cross-session: a 7d-old snapshot does not inject into `hippo context` for a different session_id on stdin', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'DF1 CLI context cross-session marker',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-owner',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    const payload = JSON.stringify({ session_id: 'sess-other', hook_event_name: 'UserPromptSubmit' });
    const result = await runHippo(['context', '--format', 'json'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('DF1 CLI context cross-session marker');
  });

  it('same-session (owner match): the same 7d-old snapshot DOES inject when stdin session_id matches the owner', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'DF1 CLI context owner-match marker',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-owner',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    const payload = JSON.stringify({ session_id: 'sess-owner', hook_event_name: 'UserPromptSubmit' });
    const result = await runHippo(['context', '--format', 'json'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DF1 CLI context owner-match marker');
  });

  it('host-var fallback: CLAUDE_CODE_SESSION_ID alone (no stdin payload) owner-matches the snapshot', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'DF1 CLI context host-var owner-match marker',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-owner-hostvar',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    delete env.HIPPO_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    env.CLAUDE_CODE_SESSION_ID = 'sess-owner-hostvar';
    // Empty string, not omitted: guarantees stdin EOF instead of a hung read on fd 0.
    const result = await runHippo(['context', '--format', 'json'], dir, env, '');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DF1 CLI context host-var owner-match marker');
  });

  it('payload wins over the host var: a different payload session_id still excludes the env owner\'s snapshot', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'DF1 CLI context payload-beats-hostvar marker',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-owner-hostvar2',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    delete env.HIPPO_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    env.CLAUDE_CODE_SESSION_ID = 'sess-owner-hostvar2';
    const payload = JSON.stringify({ session_id: 'sess-other', hook_event_name: 'UserPromptSubmit' });
    const result = await runHippo(['context', '--format', 'json'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('DF1 CLI context payload-beats-hostvar marker');
  });

  it('blank payload session_id counts as absent: falls back to CLAUDE_CODE_SESSION_ID and owner-matches', async () => {
    const hippoRoot = getHippoRoot(dir);
    const saved = saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'DF1 CLI context blank-payload-falls-back marker',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-owner-hostvar3',
      source: 'test',
    });
    backdateSnapshot(hippoRoot, saved.id, isoAgo(SEVEN_DAYS_MS));

    delete env.HIPPO_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    env.CLAUDE_CODE_SESSION_ID = 'sess-owner-hostvar3';
    const payload = JSON.stringify({ session_id: '', hook_event_name: 'UserPromptSubmit' });
    const result = await runHippo(['context', '--format', 'json'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DF1 CLI context blank-payload-falls-back marker');
  });
});
