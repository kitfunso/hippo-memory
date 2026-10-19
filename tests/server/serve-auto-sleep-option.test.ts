// serve({ autoSleep: false }): a host-tenant remember over POST /mcp or POST /v1/memories never starts consolidation;
// unset, it runs in a child, never in the server process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { serve, type ServerHandle, type ServeOpts } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sleepRuns } from '../_helpers/sleep-runs.js';

const roots: string[] = [];
const handles: ServerHandle[] = [];

beforeEach(() => {
  // No fact extraction call, and the host tenant is 'default' whatever the shell exports.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('HIPPO_TENANT', '');
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.unstubAllEnvs();
});

/** Starts a server over a fresh root with auto-sleep at threshold 2, and mints a host-tenant key. */
async function startServer(autoSleep: ServeOpts['autoSleep']): Promise<{ root: string; url: string; key: string }> {
  const root = makeRoot('serve-autosleep', { config: { autoSleep: { enabled: true, threshold: 2 } } });
  roots.push(root);
  const db = openHippoDb(root);
  let key: string;
  try {
    key = createApiKey(db, { tenantId: 'default', label: 'auto-sleep-test' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  const handle = await serve({ hippoRoot: root, port: 0, autoSleep });
  handles.push(handle);
  return { root, url: handle.url, key };
}

async function remember(url: string, key: string, text: string): Promise<void> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'hippo_remember', arguments: { text } },
    }),
  });
  expect(res.status).toBe(200);
}

/** POST /v1/memories, which api remember serves as it serves hippo_remember. */
async function rememberRest(url: string, key: string, text: string): Promise<void> {
  const res = await fetch(`${url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ content: text }),
  });
  expect(res.status).toBe(200);
}

const NOTES = ['the deploy moved to friday', 'alice owns the billing service', 'bob reviews every schema change'];

describe('serve autoSleep option', () => {
  it('autoSleep: false adds no consolidation run past the threshold', async () => {
    const { root, url, key } = await startServer(false);
    for (const note of NOTES) await remember(url, key, note);
    // Zero is final because the blank API key leaves llmPasses nothing real to await, and the trigger fires on note 2 of 3,
    // so a full round trip passes before the check; a threshold of 3 or an unconditional await would make this pass vacuously.
    expect(sleepRuns(root)).toBe(0);
  });

  it('the option unset adds one consolidation run past the threshold', async () => {
    const { root, url, key } = await startServer(undefined);
    for (const note of NOTES) await remember(url, key, note);
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1), { timeout: 20_000 });
  });

  it('a REST remember past the threshold adds one consolidation run, as hippo_remember does', async () => {
    const { root, url, key } = await startServer(undefined);
    for (const note of NOTES) await rememberRest(url, key, note);
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1), { timeout: 20_000 });
  });

  it('stop returns once the auto-sleep a write started has ended, so no sleep child still holds the store', async () => {
    const { root, url, key } = await startServer(undefined);
    for (const note of NOTES) await rememberRest(url, key, note);
    for (const h of handles.splice(0)) await h.stop();
    expect(sleepRuns(root)).toBe(1);
  });

  it('autoSleep: false stops a REST remember from starting one too', async () => {
    const { root, url, key } = await startServer(false);
    for (const note of NOTES) await rememberRest(url, key, note);
    expect(sleepRuns(root)).toBe(0);
  });

  it('runs the consolidation in a child process under the sleep deadline, not on the server event loop', async () => {
    // Only the child runner has a deadline, so a 1 ms one stops the run before it commits; in process it would finish.
    vi.stubEnv('HIPPO_SLEEP_TIMEOUT_MS', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { root, url, key } = await startServer(undefined);
      for (const note of NOTES) await remember(url, key, note);
      await vi.waitFor(
        () => {
          const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
          expect(
            lines.some((l) => l.includes('auto-sleep consolidate failed') && l.includes('did not finish within 1 ms')),
          ).toBe(true);
        },
        { timeout: 20_000 },
      );
      expect(sleepRuns(root)).toBe(0);
    } finally {
      stderr.mockRestore();
    }
  });
});
