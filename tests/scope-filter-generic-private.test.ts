/**
 * v1.2.1 preflight: generalize default-deny scope filter from `slack:private:*`
 * to ANY `*:private:*` source.
 *
 * Codex audit 2026-05-04 found that the v1.2 filter only blocks `slack:private:*`.
 * Once any other connector (GitHub, Jira, Linear, etc.) writes `<source>:private:*`
 * scoped rows, no-scope recall would leak them. v1.2.1 closes this BEFORE v1.3
 * GitHub work begins so rollback is safe.
 *
 * Coverage:
 * - api.recall (the load-bearing filter)
 * - api.recall continuity block (snapshots, handoffs, events)
 * - CLI cmdRecall continuity (mirror in cli.ts)
 * - MCP hippo_recall + hippo_context filters
 * - HTTP /v1/memories (transitively via api.recall)
 *
 * The synthetic source `acme:private:demo` proves the rule applies generically,
 * not just to slack/github by coincidence of test fixture choice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, saveActiveTaskSnapshot } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { recall } from '../src/api.js';
import { handleMcpRequest } from '../src/mcp/server.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function ctx(home: string) {
  return { hippoRoot: home, tenantId: 'default', actor: 'test' };
}

function callMcpTool(
  home: string,
  name: string,
  args: Record<string, unknown>,
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('scope filter — generic *:private:* default-deny', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('scope-generic');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('api.recall denies acme:private:demo to a no-scope caller', async () => {
    writeEntry(home, createMemory('public memory body', { scope: 'slack:public:Cgeneral' }));
    writeEntry(home, createMemory('acme private secret content', { scope: 'acme:private:demo' }));

    const result = recall(ctx(home), { query: 'secret content' });
    const ids = result.results.map((r) => r.content);
    expect(ids).not.toContain('acme private secret content');
  });

  it('api.recall denies github:private:owner/repo to a no-scope caller', async () => {
    writeEntry(home, createMemory('github private body', { scope: 'github:private:acme/secret-repo' }));

    const result = recall(ctx(home), { query: 'github private body' });
    const ids = result.results.map((r) => r.content);
    expect(ids).not.toContain('github private body');
  });

  it('api.recall denies jira:private:PROJ-1 to a no-scope caller', async () => {
    writeEntry(home, createMemory('jira ticket private text', { scope: 'jira:private:PROJ-1' }));

    const result = recall(ctx(home), { query: 'jira ticket private text' });
    const ids = result.results.map((r) => r.content);
    expect(ids).not.toContain('jira ticket private text');
  });

  it('api.recall returns acme:private:demo when scope matches exactly', async () => {
    writeEntry(home, createMemory('acme private secret content', { scope: 'acme:private:demo' }));

    const result = recall(ctx(home), { query: 'secret content', scope: 'acme:private:demo' });
    const contents = result.results.map((r) => r.content);
    expect(contents).toContain('acme private secret content');
  });

  it('api.recall does NOT leak acme:private:demo to a different explicit scope', async () => {
    writeEntry(home, createMemory('acme private secret content', { scope: 'acme:private:demo' }));

    const result = recall(ctx(home), { query: 'secret content', scope: 'slack:public:Cgeneral' });
    const contents = result.results.map((r) => r.content);
    expect(contents).not.toContain('acme private secret content');
  });

  it('api.recall continuity block denies github:private:* snapshot to no-scope caller', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'GitHub private repo task',
      summary: 'private repo work',
      next_step: 'do thing',
      session_id: 'sess-private',
      source: 'test',
      scope: 'github:private:acme/secret-repo',
    });

    const result = recall(ctx(home), { query: 'anything', includeContinuity: true });
    expect(result.continuity?.activeSnapshot).toBeNull();
  });

  it('api.recall continuity block denies acme:private:* snapshot to no-scope caller', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'ACME private task',
      summary: 'private',
      next_step: 'do',
      session_id: 'sess-acme',
      source: 'test',
      scope: 'acme:private:demo',
    });

    const result = recall(ctx(home), { query: 'anything', includeContinuity: true });
    expect(result.continuity?.activeSnapshot).toBeNull();
  });

  it('api.recall continuity returns acme:private:* snapshot to exact-scope caller', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'ACME private task',
      summary: 'private',
      next_step: 'do',
      session_id: 'sess-acme',
      source: 'test',
      scope: 'acme:private:demo',
    });

    const result = recall(ctx(home), { query: 'anything', includeContinuity: true, scope: 'acme:private:demo' });
    expect(result.continuity?.activeSnapshot?.task).toBe('ACME private task');
  });

  it('public scopes still pass through (no false positive)', async () => {
    writeEntry(home, createMemory('a public memory', { scope: 'github:public:acme/open' }));
    writeEntry(home, createMemory('another public memory', { scope: 'slack:public:Cgeneral' }));
    writeEntry(home, createMemory('untagged memory', { scope: null }));

    const result = recall(ctx(home), { query: 'memory' });
    const contents = result.results.map((r) => r.content);
    expect(contents).toContain('a public memory');
    expect(contents).toContain('another public memory');
    expect(contents).toContain('untagged memory');
  });

  it('regex does NOT match a scope that merely contains "private" mid-string', async () => {
    // `acme:public:my-private-channel` should NOT trigger default-deny —
    // the segment is "public" not "private". Guards against a sloppy substring match.
    writeEntry(home, createMemory('not-actually-private memory', { scope: 'acme:public:my-private-channel' }));

    const result = recall(ctx(home), { query: 'private memory' });
    const contents = result.results.map((r) => r.content);
    expect(contents).toContain('not-actually-private memory');
  });

  it('MCP hippo_recall denies github:private:* to no-scope caller', async () => {
    writeEntry(home, createMemory('mcp github private body', { scope: 'github:private:acme/secret-repo' }));
    writeEntry(home, createMemory('mcp public body', { scope: 'github:public:acme/open' }));

    const res = await callMcpTool(home, 'hippo_recall', { query: 'body' });
    const text = extractText(res);
    expect(text).not.toContain('mcp github private body');
    expect(text).toContain('mcp public body');
  });

  it('MCP hippo_context denies acme:private:* snapshot to no-scope caller', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'mcp acme private task',
      summary: 'private',
      next_step: 'do',
      session_id: 'sess-mcp-acme',
      source: 'test',
      scope: 'acme:private:demo',
    });

    const res = await callMcpTool(home, 'hippo_context', {});
    const text = extractText(res);
    expect(text).not.toContain('mcp acme private task');
  });

  it('MCP hippo_recall denies jira:private:* memory to no-scope caller', async () => {
    writeEntry(home, createMemory('mcp jira ticket private text', { scope: 'jira:private:PROJ-1' }));

    const res = await callMcpTool(home, 'hippo_recall', { query: 'jira ticket' });
    const text = extractText(res);
    expect(text).not.toContain('mcp jira ticket private text');
  });
});
