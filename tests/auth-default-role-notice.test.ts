// A key minted with no role is an admin key that never expires; the default stays, so the mint says it out loud.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { cmdAuth } from '../src/cli/auth.js';
import { log } from '../src/log.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const NOTICE = /admin key, and it never expires/;

let root: string;

beforeEach(() => {
  root = makeRoot('default-role');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('hippo auth create', () => {
  it('says on stderr that a key made without --role is an admin key with no expiry, and keeps --json stdout clean', async () => {
    const run = await runInProcess(() => cmdAuth(root, ['create'], { json: true }));
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(NOTICE);
    expect(run.stderr).toContain('--role member');
    // SAFETY: --json prints one object with these fields; the assertions check them.
    const printed = JSON.parse(run.stdout) as { role: string; plaintext: string };
    expect(printed.role).toBe('admin');
    expect(run.stderr).not.toContain(printed.plaintext);
  });

  it.each(['admin', 'member'])('stays quiet when --role %s is chosen', async (role) => {
    const run = await runInProcess(() => cmdAuth(root, ['create'], { role }));
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(`role:      ${role}`);
  });
});

describe('POST /v1/auth/keys', () => {
  let handle: ServerHandle;

  beforeEach(async () => {
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  interface Minted { keyId: string; plaintext: string; role: string }

  async function mint(body: Record<string, string>): Promise<Minted> {
    const res = await fetch(`${handle.url}/v1/auth/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    // SAFETY: the mint route answers 200 with these fields; the assertions check them.
    return (await res.json()) as Minted;
  }

  it('logs a warning that names the key id, never the key, when the body has no role', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const minted = await mint({ label: 'no role given' });
    expect(minted.role).toBe('admin');
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => NOTICE.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(minted.keyId);
    expect(lines[0]).not.toContain(minted.plaintext);
  });

  it.each(['admin', 'member'])('logs nothing when the body asks for role %s', async (role) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect((await mint({ role })).role).toBe(role);
    expect(warn.mock.calls.filter((call) => NOTICE.test(String(call[0])))).toEqual([]);
  });
});
