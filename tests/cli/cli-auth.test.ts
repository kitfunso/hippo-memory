import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';

const savedCwd = process.cwd();
let home = '';

const run = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

async function hippo(...args: string[]): Promise<string> {
  const res = await run(...args);
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

beforeEach(() => {
  home = makeRoot('auth-cli', { init: false });
  vi.stubEnv('HIPPO_HOME', home);
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

describe('hippo auth CLI', () => {
  it('create -> list -> revoke flow', async () => {
    await hippo('init', '--global');
    const created = await run('auth', 'create', '--label', 'test', '--global');
    const createOut = created.stdout;
    const keyMatch = createOut.match(/(hk_[a-z2-7]{24})/);
    const plainMatch = createOut.match(/(hk_[a-z2-7]{24}\.[a-z2-7]+)/);
    expect(keyMatch?.[1], 'key_id missing in output').toMatch(/^hk_[a-z2-7]{24}$/);
    expect(plainMatch?.[1], 'plaintext missing in output').toMatch(/^hk_[a-z2-7]{24}\.[a-z2-7]+$/);
    const keyId = keyMatch![1]!;
    // No --role means a member key that expires, so the mint says so: on stderr, and without the key.
    expect(created.stderr).toContain('no --role given, so this is a member key');
    expect(created.stderr).not.toContain(plainMatch![1]!);
    const narrow = await run('auth', 'create', '--role', 'member', '--global');
    expect([narrow.status, narrow.stderr.includes('no --role given')]).toEqual([0, false]);

    const listOut = await hippo('auth', 'list', '--global');
    expect(listOut).toContain(keyId);
    expect(listOut).toContain('test');

    await hippo('auth', 'revoke', keyId, '--global');
    expect(await hippo('auth', 'list', '--global')).not.toContain(keyId);
    expect(await hippo('auth', 'list', '--all', '--global')).toContain(keyId);
  });
});
