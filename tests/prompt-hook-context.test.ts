// promptHookContext answers a store-less laptop's per-prompt hook with the bytes the local hook would print.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { adminActor, type Context } from '../src/api.js';
import { hashArm } from '../src/pilot-arm.js';
import { resolveProjectIdentity } from '../src/project-identity.js';
import { promptHookContext } from '../src/prompt-hook.js';
import { HIPPO_PINNED_INJECT_COMMAND } from '../src/hooks/shared.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const REPO = path.resolve(__dirname, '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');
// The command Claude Code runs on every prompt, so a change to its flags fails the parity case below.
const HOOK_ARGS = HIPPO_PINNED_INJECT_COMMAND.split(' ').slice(1);

// The env inputs a direct call cannot see are dropped from the CLI side.
const CLI_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const name of ['HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_TENANT']) {
  delete CLI_ENV[name];
}

interface LedgerRow { session_id: string | null; tenant_id: string; surface: string; event: string; items: number; block_hash: string | null }
type HookPayload = { session_id: string; prompt?: string; hook_event_name?: string; agent_id?: string };

let tmp: string;
const origHome = process.env.HIPPO_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-prompt-hook-'));
  // An empty global store on both sides, so neither the CLI nor the call mixes in a real one.
  process.env.HIPPO_HOME = path.join(tmp, 'global');
});

afterEach(() => {
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

const ctxFor = (store: string): Context => ({ hippoRoot: store, tenantId: 'default', actor: adminActor('prompt-hook-test') });

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

const PROJECT_P = { name: 'p', legacyName: 'p' };

describe('promptHookContext', () => {
  it('prints the bytes the local hook prints for the same store, project and session', async () => {
    const cliProj = path.join(tmp, 'cli', 'proj');
    // A project file id plus an origin remote, so rows filed under the remote id reach the call only as an alias.
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

    const project = resolveProjectIdentity(cliProj);
    expect(project).toMatchObject({ name: 'acme-proj', legacyName: 'proj', aliases: ['github.com/acme/proj', 'proj'] });
    const ctx = ctxFor(srvStore);
    expect(await promptHookContext(ctx, { sessionId: 'parity', project, payload: withPrompt })).toEqual({ arm: null, stdout: expected[0] });
    expect(await promptHookContext(ctx, { sessionId: 'parity-recent', project, payload: noPrompt })).toEqual({ arm: null, stdout: expected[1] });
  });

  it('rate 10000: books a holdout arm row and prints nothing, as the local holdout does', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    expect(await promptHookContext(ctxFor(store), { sessionId: 'h1', project: PROJECT_P })).toEqual({ arm: 'holdout', stdout: '' });
    expect(ledger(store, `event = 'arm'`)).toEqual([
      { session_id: 'h1', tenant_id: 'default', surface: 'pilot', event: 'arm', items: 10000, block_hash: 'holdout' },
    ]);
    expect(ledger(store, `event = 'inject'`)).toEqual([]);
  });

  it('a treatment session gets the block and a `hippo` arm row', async () => {
    const store = makeProject(path.join(tmp, 'p'), 5000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const id = sessionFor('hippo', 5000);
    const reply = await promptHookContext(ctxFor(store), { sessionId: id, project: PROJECT_P });
    expect(reply.arm).toBe('hippo');
    expect(reply.stdout).toContain('rollback plan');
    expect(ledger(store, `event = 'arm'`).map((r) => [r.session_id, r.block_hash, r.items])).toEqual([[id, 'hippo', 5000]]);
  });

  it('rate 0: arm is null and no arm row is booked', async () => {
    const store = makeProject(path.join(tmp, 'p'), 0);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const reply = await promptHookContext(ctxFor(store), { sessionId: 'z0', project: PROJECT_P });
    expect(reply.arm).toBeNull();
    expect(reply.stdout).toContain('rollback plan');
    expect(ledger(store, `event = 'arm'`)).toEqual([]);
  });

  it('a sub-agent payload books no arm and follows its parent session', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    await promptHookContext(ctx, { sessionId: 'parent', project: PROJECT_P });
    const sub = await promptHookContext(ctx, { sessionId: 'parent', project: PROJECT_P, payload: { session_id: 'parent', agent_id: 'a1' } });
    expect(sub).toEqual({ arm: 'holdout', stdout: '' });
    const lonely = await promptHookContext(ctx, { sessionId: 'lonely', project: PROJECT_P, payload: { session_id: 'lonely', agent_id: 'a2' } });
    expect(lonely).toEqual({ arm: 'holdout', stdout: '' });
    expect(ledger(store, `event = 'arm'`).map((r) => r.session_id)).toEqual(['parent']);
  });

  it('skips the unchanged block on a repeat prompt in one session, as the local hook does', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'again', project: PROJECT_P });
    expect(first.stdout).toContain('rollback plan');
    expect(await promptHookContext(ctx, { sessionId: 'again', project: PROJECT_P })).toEqual({ arm: null, stdout: '' });
    expect(ledger(store, `event = 'skip'`).map((r) => [r.session_id, r.surface])).toEqual([['again', 'hook']]);
  });
});

describe('package exports the enterprise hook client loads', () => {
  it.each([
    ['hippo-memory/project-identity', 'resolveProjectIdentity'],
    ['hippo-memory/json-hooks', 'uninstallJsonHooks'],
    ['hippo-memory/json-hooks', 'resolveJsonHookPaths'],
    ['hippo-memory/server', 'promptHookContext'],
    ['hippo-memory/server', 'HttpError'],
  ])('%s exports %s from the build', (specifier, name) => {
    const script = `const m = await import('${specifier}'); console.log(typeof m.${name});`;
    // cwd is the checkout because self-reference resolves from the nearest package.json.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf-8', timeout: 30_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('function');
  });
});
