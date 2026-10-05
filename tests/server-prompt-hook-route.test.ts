// POST /v1/hooks/prompt answers a store-less laptop's per-prompt hook with the bytes the local hook would print.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { hashArm } from '../src/pilot-arm.js';
import { resolveProjectIdentity } from '../src/project-identity.js';
import { HIPPO_PINNED_INJECT_COMMAND } from '../src/hooks/shared.js';
import type { JsonValue } from '../src/json.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const REPO = path.resolve(__dirname, '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');
// The command Claude Code runs on every prompt, so a change to its flags fails the parity case below.
const HOOK_ARGS = HIPPO_PINNED_INJECT_COMMAND.split(' ').slice(1);

// Taken before beforeEach sets HIPPO_REQUIRE_AUTH; the env inputs a server cannot see are dropped.
const CLI_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const name of ['HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_TENANT']) {
  delete CLI_ENV[name];
}

interface HookReply { arm?: 'treatment' | 'holdout' | null; stdout?: string; error?: string }
interface LedgerRow { session_id: string | null; tenant_id: string; surface: string; event: string; items: number; block_hash: string | null }
type HookPayload = { session_id: string; prompt?: string; hook_event_name?: string; agent_id?: string };

let tmp: string;
let handle: ServerHandle | null = null;
let baseUrl = '';
let apiKey = '';
const origHome = process.env.HIPPO_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-prompt-hook-'));
  // An empty global store on both sides, so neither the CLI nor the server mixes in a real one.
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  process.env.HIPPO_REQUIRE_AUTH = '1';
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  delete process.env.HIPPO_REQUIRE_AUTH;
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A project folder with its own `.hippo` store; a rate writes the store's pilot config. */
function makeProject(dir: string, rateBp: number | null = null): string {
  const store = path.join(dir, '.hippo');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  if (rateBp !== null) fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ pilot: { holdoutRateBp: rateBp } }));
  return store;
}

function pin(store: string, content: string, origin: string): void {
  writeEntry(store, { ...createMemory(content), pinned: true, origin_project: origin });
}

async function serveStore(store: string): Promise<void> {
  const db = openHippoDb(store);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'prompt-hook-test' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  handle = await serve({ hippoRoot: store, host: '127.0.0.1', port: 0 });
  baseUrl = handle.url;
}

async function postHook(body: JsonValue, event = 'prompt', key: string | null = apiKey): Promise<{ status: number; reply: HookReply }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key !== null) headers.set('authorization', `Bearer ${key}`);
  const res = await fetch(`${baseUrl}/v1/hooks/${event}`, { method: 'POST', headers, body: JSON.stringify(body) });
  // SAFETY: every status this file reaches answers JSON with these optional fields, asserted right after.
  return { status: res.status, reply: (await res.json()) as HookReply };
}

function ledger(store: string, where: string): LedgerRow[] {
  const db = openHippoDb(store);
  try {
    // SAFETY: the SELECT names exactly the columns of LedgerRow.
    return db.prepare(`SELECT session_id, tenant_id, surface, event, items, block_hash FROM token_ledger WHERE ${where} ORDER BY id`).all() as LedgerRow[];
  } finally {
    closeHippoDb(db);
  }
}

function localHook(projectDir: string, payload: HookPayload): string {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...HOOK_ARGS], {
    cwd: projectDir, env: { ...CLI_ENV, HIPPO_HOME: path.join(tmp, 'global') }, input: JSON.stringify(payload), encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** A session id whose hash arm is `arm` at `rate`, so a rate-driven case never depends on luck. */
function sessionFor(arm: 'hippo' | 'holdout', rate: number): string {
  for (let i = 0; ; i++) if (hashArm(`s-${i}`, rate) === arm) return `s-${i}`;
}

describe('POST /v1/hooks/prompt', () => {
  it('prints the bytes the local hook prints for the same store, project and session', async () => {
    const cliProj = path.join(tmp, 'cli', 'proj');
    // A project file id plus an origin remote, so rows filed under the remote id reach the server only as an alias.
    // Written before the store, whose set-up caches this folder's identity in-process.
    fs.mkdirSync(path.join(cliProj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cliProj, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/proj.git\n');
    fs.writeFileSync(path.join(cliProj, '.hippo-project.json'), JSON.stringify({ id: 'acme-proj' }));
    const cliStore = makeProject(cliProj);
    pin(cliStore, 'PINNED: always check the rollback plan before deploy', 'proj');
    pin(cliStore, 'PINNED: the remote-named rows still reach this checkout', 'github.com/acme/proj');
    pin(cliStore, 'PINNED: the other team rotates the handshake key', 'other');
    writeEntry(cliStore, {
      ...createMemory('Kafka consumers in the billing service must be paused with kafka-pause.sh before a schema migration'),
      origin_project: 'proj',
    });
    for (let i = 0; i < 7; i++) {
      writeEntry(cliStore, { ...createMemory(`Release train ${i}: the payments worker on port 80${i}1 drains for 90 seconds before the cutover`), origin_project: 'proj' });
    }
    saveActiveTaskSnapshot(cliStore, 'default', { task: 'ship', summary: 'half done', next_step: 'run tests', session_id: 'parity' });
    // Copied before either side runs: the first prompt of a session must not see the other side's ledger rows.
    const srvStore = path.join(tmp, 'srv', 'proj', '.hippo');
    fs.cpSync(cliStore, srvStore, { recursive: true });

    // A prompt swaps the recent-5 backfill for prompt recall, so one session takes each path.
    const withPrompt: HookPayload = { session_id: 'parity', prompt: 'how do we pause the kafka consumers for the billing migration', hook_event_name: 'UserPromptSubmit' };
    const noPrompt: HookPayload = { session_id: 'parity-recent', hook_event_name: 'UserPromptSubmit' };
    const expected = [localHook(cliProj, withPrompt), localHook(cliProj, noPrompt)];
    expect(expected[0]).toContain('Active Task Snapshot');
    expect(expected[0]).toContain('Prompt-Relevant Memory');
    expect(expected[1]).toContain('Release train');
    for (const out of expected) {
      expect(out).toContain('rollback plan');
      expect(out).toContain('remote-named rows');
      expect(out).not.toContain('handshake');
    }

    await serveStore(srvStore);
    const id = resolveProjectIdentity(cliProj);
    expect(id).toMatchObject({ name: 'acme-proj', legacyName: 'proj', aliases: ['github.com/acme/proj', 'proj'] });
    const project = { name: id.name, legacy_name: id.legacyName, aliases: [...(id.aliases ?? [])] };
    expect(await postHook({ session_id: 'parity', project, payload: withPrompt })).toEqual({ status: 200, reply: { arm: null, stdout: expected[0] } });
    expect(await postHook({ session_id: 'parity-recent', project, payload: noPrompt })).toEqual({ status: 200, reply: { arm: null, stdout: expected[1] } });
  });

  it('gives each project in one store only its own pinned memories, never by where the store sits', async () => {
    const store = makeProject(path.join(tmp, 'team'));
    pin(store, 'PINNED: alpha ships with blue-green deploys', 'proj-a');
    pin(store, 'PINNED: beta freezes deploys on Fridays', 'proj-b');
    pin(store, 'PINNED: gamma keeps its folder-name rows', 'gamma');
    await serveStore(store);

    const a = (await postHook({ session_id: 'sa', project: { name: 'proj-a' } })).reply.stdout;
    expect(a).toContain('blue-green');
    expect(a).not.toContain('Fridays');
    const b = (await postHook({ session_id: 'sb', project: { name: 'proj-b' } })).reply.stdout;
    expect(b).toContain('Fridays');
    expect(b).not.toContain('blue-green');
    const legacy = await postHook({ session_id: 'sc', project: { name: 'github.com/acme/gamma', legacy_name: 'gamma' } });
    expect(legacy.reply.stdout).toContain('folder-name rows');
    expect(await postHook({ session_id: 'sd', project: { name: 'team' } })).toEqual({ status: 200, reply: { arm: null, stdout: '' } });
  });

  it('rate 10000: books a holdout arm row and prints nothing, as the local holdout does', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    expect(await postHook({ session_id: 'h1', project: { name: 'p' } })).toEqual({ status: 200, reply: { arm: 'holdout', stdout: '' } });
    expect(ledger(store, `event = 'arm'`)).toEqual([
      { session_id: 'h1', tenant_id: 'default', surface: 'pilot', event: 'arm', items: 10000, block_hash: 'holdout' },
    ]);
    expect(ledger(store, `event = 'inject'`)).toEqual([]);
  });

  it('a treatment session gets the block and a `hippo` arm row', async () => {
    const store = makeProject(path.join(tmp, 'p'), 5000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    const id = sessionFor('hippo', 5000);
    const { reply } = await postHook({ session_id: id, project: { name: 'p' } });
    expect(reply.arm).toBe('treatment');
    expect(reply.stdout).toContain('rollback plan');
    expect(ledger(store, `event = 'arm'`).map((r) => [r.session_id, r.block_hash, r.items])).toEqual([[id, 'hippo', 5000]]);
  });

  it('rate 0: arm is null and no arm row is booked', async () => {
    const store = makeProject(path.join(tmp, 'p'), 0);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    const { reply } = await postHook({ session_id: 'z0', project: { name: 'p' } });
    expect(reply.arm).toBeNull();
    expect(reply.stdout).toContain('rollback plan');
    expect(ledger(store, `event = 'arm'`)).toEqual([]);
  });

  it('a sub-agent payload books no arm and follows its parent session', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    await postHook({ session_id: 'parent', project: { name: 'p' } });
    const sub = await postHook({ session_id: 'parent', project: { name: 'p' }, payload: { session_id: 'parent', agent_id: 'a1' } });
    expect(sub.reply).toEqual({ arm: 'holdout', stdout: '' });
    const lonely = await postHook({ session_id: 'lonely', project: { name: 'p' }, payload: { session_id: 'lonely', agent_id: 'a2' } });
    expect(lonely.reply).toEqual({ arm: 'holdout', stdout: '' });
    expect(ledger(store, `event = 'arm'`).map((r) => r.session_id)).toEqual(['parent']);
  });

  it('writes the hook ledger rows on the server with the session id and the key tenant', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    await postHook({ session_id: 'ledger-1', project: { name: 'p' }, payload: { prompt: 'rollback' } });
    const rows = ledger(store, `event = 'inject'`).map((r) => [r.session_id, r.tenant_id, r.surface]);
    expect(rows).toContainEqual(['ledger-1', 'default', 'hook']);
    expect(rows.every(([sessionId]) => sessionId === 'ledger-1')).toBe(true);
  });

  it('skips the unchanged block on a repeat prompt in one session, as the local hook does', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    await serveStore(store);
    const first = await postHook({ session_id: 'again', project: { name: 'p' } });
    expect(first.reply.stdout).toContain('rollback plan');
    expect(await postHook({ session_id: 'again', project: { name: 'p' } })).toEqual({ status: 200, reply: { arm: null, stdout: '' } });
    expect(ledger(store, `event = 'skip'`).map((r) => [r.session_id, r.surface])).toEqual([['again', 'hook']]);
  });

  it('400s a missing or blank session_id, a missing project, a nameless project, bad aliases and a non-object payload', async () => {
    await serveStore(makeProject(path.join(tmp, 'p')));
    const bad: JsonValue[] = [
      { project: { name: 'p' } },
      { session_id: '  ', project: { name: 'p' } },
      { session_id: 'x'.repeat(257), project: { name: 'p' } },
      { session_id: 's' },
      { session_id: 's', project: 'p' },
      { session_id: 's', project: {} },
      { session_id: 's', project: { name: 'p', legacy_name: 7 } },
      { session_id: 's', project: { name: 'p', aliases: 'q' } },
      { session_id: 's', project: { name: 'p', aliases: ['q', ' '] } },
      { session_id: 's', project: { name: 'p', aliases: Array.from({ length: 9 }, (_, i) => `a${i}`) } },
      { session_id: 's', project: { name: 'p' }, payload: 'not an object' },
    ];
    for (const body of bad) expect((await postHook(body)).status, JSON.stringify(body)).toBe(400);
  });

  it('404s an unknown event once the caller is authed, and 401s any event without a valid key', async () => {
    await serveStore(makeProject(path.join(tmp, 'p')));
    const body = { session_id: 's', project: { name: 'p' } };
    expect(await postHook(body, 'session-end')).toEqual({ status: 404, reply: { error: 'unknown hook event' } });
    expect((await postHook(body, 'prompt', null)).status).toBe(401);
    expect((await postHook(body, 'session-end', null)).status).toBe(401);
    expect((await postHook(body, 'prompt', 'hk_invalid.deadbeef')).status).toBe(401);
  });
});

describe('package exports the enterprise hook client loads', () => {
  it.each([
    ['hippo-memory/project-identity', 'resolveProjectIdentity'],
    ['hippo-memory/json-hooks', 'uninstallJsonHooks'],
    ['hippo-memory/json-hooks', 'resolveJsonHookPaths'],
  ])('%s exports %s from the build', (specifier, name) => {
    const script = `const m = await import('${specifier}'); console.log(typeof m.${name});`;
    // cwd is the checkout because self-reference resolves from the nearest package.json.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf-8', timeout: 30_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('function');
  });
});
