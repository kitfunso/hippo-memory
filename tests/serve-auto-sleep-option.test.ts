// serve({ autoSleep: false }): a host-tenant remember over POST /mcp never starts consolidation in the server process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { serve, type ServerHandle, type ServeOpts } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';
import { sleepRuns } from './_helpers/sleep-runs.js';

const roots: string[] = [];
const handles: ServerHandle[] = [];

beforeEach(() => {
  // No fact extraction call, and the host tenant is 'default' whatever the shell exports.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('HIPPO_TENANT', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of handles.splice(0)) await h.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1));
  });
});
