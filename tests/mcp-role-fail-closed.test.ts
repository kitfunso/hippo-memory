// Only stdio, which passes no MCP context, acts as the local operator; a context that lacks a role fails closed, and tools that read the server's cwd
// (hippo_learn's git scan, hippo_context's git auto-detect) refuse or skip it for any remote caller but a host admin.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadConfig } from '../src/core/config.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { mcpActor } from '../src/mcp/protocol.js';
import { runLearnTool } from '../src/mcp/memory-tools.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

// Both suites run git in child processes.
vi.setConfig({ testTimeout: 30_000 });

const LESSON = 'fix the retry loop that dropped the last queued webhook delivery';

/** A temp git repo with one lesson-shaped commit; `beforeCommit` runs first, e.g. to switch branch. */
function initRepo(beforeCommit?: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-role-repo-'));
  const git = (...args: readonly string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  if (beforeCommit) git(...beforeCommit);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', LESSON);
  return dir;
}

function contextText(res: McpResponse | null): string {
  // SAFETY: a tools/call reply wraps tool output as result.content[{type:'text',text}].
  return (res?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '';
}

/** What an untyped transport (a .mjs script, an older add-on) sends: the compiler cannot stop it omitting the role. */
function roleless(hippoRoot: string): McpContext {
  // SAFETY: deliberately drops the required role to prove the runtime fails closed for callers the type cannot reach.
  return JSON.parse(JSON.stringify({ hippoRoot, tenantId: 'default', actor: 'http:untyped' })) as McpContext;
}

function callTool(name: string, args: Record<string, number>, ctx: McpContext) {
  return handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
}

describe('mcpActor', () => {
  it('runs stdio, which passes no context, as the host-admin local operator', () => {
    expect(mcpActor(undefined)).toMatchObject({ subject: 'mcp', role: 'admin', hostAdmin: true });
  });

  it('runs a context with no role as a member and never as host admin', () => {
    const actor = mcpActor(roleless('/unused'));
    expect(actor.role).toBe('member');
    expect(actor.hostAdmin).toBeUndefined();
  });

  it('gives an admin context host admin only when the transport says so', () => {
    expect(mcpActor({ hippoRoot: '/unused', tenantId: 't', actor: 'k', role: 'admin' }).hostAdmin).toBeUndefined();
    expect(mcpActor({ hippoRoot: '/unused', tenantId: 't', actor: 'k', role: 'admin', hostAdmin: true }).hostAdmin).toBe(true);
  });
});

describe('hippo_learn scans the server cwd only for stdio or a host admin', () => {
  let repoDir: string;
  let hippoRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    repoDir = initRepo();
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-role-store-'));
    initStore(hippoRoot);
    originalCwd = process.cwd();
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('refuses an HTTP-MCP context with no role, so it cannot run the admin-only tool', async () => {
    await expect(callTool('hippo_learn', { days: 3650 }, roleless(hippoRoot))).rejects.toThrow('hippo_learn requires a host admin');
    expect(loadAllEntries(hippoRoot)).toEqual([]);
  });

  it("refuses a remote member and a tenant admin, whose repo is not the server's", async () => {
    for (const role of ['member', 'admin'] as const) {
      const ctx: McpContext = { hippoRoot, tenantId: 'default', actor: `api_key:${role}`, role };
      await expect(callTool('hippo_learn', { days: 3650 }, ctx)).rejects.toThrow('hippo_learn requires a host admin');
    }
    expect(loadAllEntries(hippoRoot)).toEqual([]);
  });

  it('learns for stdio, the local operator, as before', async () => {
    const text = await runLearnTool({ args: { days: 3650 }, ctx: undefined, hippoRoot, config: loadConfig(hippoRoot), tenantId: 'default' });
    expect(text).toMatch(/^Git learn: 1 new/);
    expect(loadAllEntries(hippoRoot).some((e) => e.content.includes('retry loop'))).toBe(true);
  });
});

describe('hippo_context reads the server git state only for stdio or a host admin', () => {
  let repoDir: string;
  let hippoRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    // The server's checkout sits on a feature branch, so the git auto-detect would query for its name.
    repoDir = initRepo(['checkout', '-q', '-b', 'zebra-migration']);
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-role-ctx-'));
    initStore(hippoRoot);
    writeEntry(hippoRoot, createMemory('zebra migration runbook lives in the ops wiki', { tenantId: 'default' }));
    writeEntry(hippoRoot, createMemory('quarterly invoices are filed under finance', { tenantId: 'default' }));
    originalCwd = process.cwd();
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it("lists a remote member's rows by strength, with no query from the server's branch", async () => {
    const text = contextText(await callTool('hippo_context', {}, { hippoRoot, tenantId: 'default', actor: 'api_key:m', role: 'member' }));
    expect(text).toContain('quarterly invoices');
    expect(text).toContain('zebra migration');
  });

  it("queries a host admin's context by the server's branch, as stdio does", async () => {
    const text = contextText(await callTool('hippo_context', {}, { hippoRoot, tenantId: 'default', actor: 'localhost:cli', role: 'admin', hostAdmin: true }));
    expect(text).toContain('zebra migration');
    expect(text).not.toContain('quarterly invoices');
  });
});
