// promptHookContext answers a store-less laptop's per-prompt hook with the bytes the local hook would print.
import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { recordTokenUse } from '../src/store/token-ledger.js';
import type { JsonValue } from '../src/util/json.js';
import { adminActor } from '../src/api/index.js';
import { BadRequestError } from '../src/core/api-errors.js';
import { MAX_ID_LEN } from '../src/util/limits.js';
import { hashArm } from '../src/store/pilot-arm.js';
import { resolveProjectIdentity } from '../src/core/project-identity.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { HIPPO_PINNED_INJECT_COMMAND } from '../src/hooks/shared.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { hippoRun } from './_helpers/spawn-hippo.js';
import { apiCtx } from './_helpers/api-ctx.js';

const REPO = path.resolve(__dirname, '..');
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

const ctxFor = (store: string): FullContext => (apiCtx(store, 'default', adminActor('prompt-hook-test')));

function ledger(store: string, where: string): LedgerRow[] {
  const db = openHippoDb(store);
  try {
    // SAFETY: the SELECT names exactly the columns of LedgerRow.
    return db.prepare(`SELECT session_id, tenant_id, surface, event, items, block_hash FROM token_ledger WHERE ${where} ORDER BY id`).all() as LedgerRow[];
  } finally {
    closeHippoDb(db);
  }
}

function withDb<T>(store: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(store);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The parsed sent_keys of a session's `hook` rows in booking order; null for a row that carries none. */
function sentKeys(store: string, sessionId: string): Array<JsonValue | null> {
  // SAFETY: the SELECT names exactly this one nullable TEXT column.
  const rows = withDb(store, (db) => db.prepare(
    `SELECT sent_keys FROM token_ledger WHERE surface = 'hook' AND session_id = ? ORDER BY id`,
  ).all(sessionId) as Array<{ sent_keys: string | null }>);
  // SAFETY: the hook writes sent_keys with JSON.stringify.
  return rows.map((r) => (r.sent_keys === null ? null : (JSON.parse(r.sent_keys) as JsonValue)));
}

/** The row a host compaction books (cli/hook-runtime.ts resetHookInjection). */
function bookReset(store: string, sessionId: string): void {
  withDb(store, (db) => recordTokenUse(db, { tenantId: 'default', sessionId, surface: 'hook', event: 'reset', items: 0, tokens: 0 }));
}

function localHook(projectDir: string, payload: HookPayload): string {
  const r = hippoRun(HOOK_ARGS, { cwd: projectDir, env: { ...CLI_ENV, HIPPO_HOME: path.join(tmp, 'global') }, input: JSON.stringify(payload) });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** A session id whose hash arm is `arm` at `rate`, so a rate-driven case never depends on luck. */
function sessionFor(arm: 'hippo' | 'holdout', rate: number): string {
  for (let i = 0; ; i++) if (hashArm(`s-${i}`, rate) === arm) return `s-${i}`;
}

const PROJECT_P = { name: 'p', legacyName: 'p' };
const BLOCK_HASH_RE = /^[0-9a-f]{16}$/;
const MEM_KEY_RE = /^mem:[^:]+:[0-9a-f]{16}$/;
const NOTHING = { stdout: '', staticHash: null };

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
    const staticHash = expect.stringMatching(BLOCK_HASH_RE);
    expect(await promptHookContext(ctx, { sessionId: 'parity', project, payload: withPrompt })).toEqual({ arm: null, stdout: expected[0], staticHash });
    expect(await promptHookContext(ctx, { sessionId: 'parity-recent', project, payload: noPrompt })).toEqual({ arm: null, stdout: expected[1], staticHash });
  });

  it('prints the task state when no pin or memory is there to pick, as the local hook does', async () => {
    const dir = path.join(tmp, 'p');
    const store = makeProject(dir);
    saveActiveTaskSnapshot(store, 'default', { task: 'ship', summary: 'half done', next_step: 'run tests', session_id: 'state-only' });
    const payload: HookPayload = { session_id: 'state-only', hook_event_name: 'UserPromptSubmit' };
    const out = await promptHookContext(ctxFor(store), { sessionId: 'state-only', project: PROJECT_P, payload });
    expect(out.stdout).toContain('Active Task Snapshot');
    expect(localHook(dir, { ...payload, session_id: 'state-only-cli' })).toContain('Active Task Snapshot');
  });

  it('rate 10000: books a holdout arm row and prints nothing, as the local holdout does', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    expect(await promptHookContext(ctxFor(store), { sessionId: 'h1', project: PROJECT_P })).toEqual({ arm: 'holdout', ...NOTHING });
    expect(ledger(store, `event = 'arm'`)).toEqual([
      { session_id: 'h1', tenant_id: 'default', surface: 'pilot', event: 'arm', items: 10000, block_hash: 'holdout' },
    ]);
    expect(ledger(store, `event = 'inject'`)).toEqual([]);
  });

  it('books the holdout arm row under the caller tenant, never the default one', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    const ctx: FullContext = apiCtx(store, 't1', adminActor('prompt-hook-test'));
    expect(await promptHookContext(ctx, { sessionId: 'h-t1', project: PROJECT_P })).toEqual({ arm: 'holdout', ...NOTHING });
    expect(ledger(store, `event = 'arm'`).map((r) => [r.session_id, r.tenant_id])).toEqual([['h-t1', 't1']]);
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
    expect(sub).toEqual({ arm: 'holdout', ...NOTHING });
    const lonely = await promptHookContext(ctx, { sessionId: 'lonely', project: PROJECT_P, payload: { session_id: 'lonely', agent_id: 'a2' } });
    expect(lonely).toEqual({ arm: 'holdout', ...NOTHING });
    expect(ledger(store, `event = 'arm'`).map((r) => r.session_id)).toEqual(['parent']);
  });

  it('holds a printed pin back on a repeat prompt, its mark pending until the caller echoes the hash', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'again', project: PROJECT_P });
    expect(first.stdout).toContain('rollback plan');
    expect(first.staticHash).toMatch(BLOCK_HASH_RE);
    expect(sentKeys(store, 'again')).toEqual([{ pending: [expect.stringMatching(MEM_KEY_RE)] }]);
    const printedHash = first.staticHash ?? undefined;
    expect(await promptHookContext(ctx, { sessionId: 'again', project: PROJECT_P, printedHash })).toEqual({ arm: null, ...NOTHING });
    expect(sentKeys(store, 'again')).toEqual([[expect.stringMatching(MEM_KEY_RE)], []]);
    expect(ledger(store, `event = 'skip'`).map((r) => [r.session_id, r.surface])).toEqual([['again', 'hook']]);
  });

  it('sends the block again with no printed hash, though the ledger booked the same block last', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'lost', project: PROJECT_P });
    // A reply lost on the way, or a compaction the server never saw: the caller has no hash to send.
    const second = await promptHookContext(ctx, { sessionId: 'lost', project: PROJECT_P });
    expect(second).toEqual(first);
    expect(ledger(store, `event = 'inject' AND surface = 'hook'`).map((r) => r.block_hash)).toEqual([first.staticHash, first.staticHash]);
    expect(ledger(store, `event = 'skip'`)).toEqual([]);
  });

  it('sends only the new pin when the caller printed an older block, and books the held one as a skip', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'old', project: PROJECT_P });
    pin(store, 'PINNED: the canary runs for an hour before the full rollout', 'p');
    const second = await promptHookContext(ctx, { sessionId: 'old', project: PROJECT_P, printedHash: first.staticHash ?? undefined });
    expect(second.stdout).toContain('canary runs');
    expect(second.stdout).not.toContain('rollback plan');
    expect(second.staticHash).toMatch(BLOCK_HASH_RE);
    expect(second.staticHash).not.toBe(first.staticHash);
    expect(ledger(store, `event = 'skip'`).map((r) => [r.surface, r.items])).toEqual([['hook', 1]]);
  });

  it('prints an edited memory again at once, as its key carries the content hash', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    const entry = { ...createMemory('PINNED: always check the rollback plan'), pinned: true, origin_project: 'p' };
    writeEntry(store, entry);
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'edit', project: PROJECT_P });
    writeEntry(store, { ...entry, content: 'PINNED: always check the rollback plan and the canary' });
    const second = await promptHookContext(ctx, { sessionId: 'edit', project: PROJECT_P, printedHash: first.staticHash ?? undefined });
    expect(second.stdout).toContain('rollback plan and the canary');
  });

  it('prints a pin again 10 turns after its last send, and any other memory once its mark lapses at 25', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    writeEntry(store, { ...createMemory('Kafka consumers in the billing service must be paused first'), origin_project: 'p' });
    const ctx = ctxFor(store);
    const pinTurns: number[] = [];
    const recentTurns: number[] = [];
    let printedHash: string | undefined;
    for (let turn = 0; turn < 27; turn++) {
      const reply = await promptHookContext(ctx, { sessionId: 'long', project: PROJECT_P, printedHash });
      if (reply.stdout.includes('rollback plan')) pinTurns.push(turn);
      if (reply.stdout.includes('Kafka consumers')) recentTurns.push(turn);
      printedHash = reply.staticHash ?? printedHash;
    }
    expect(pinTurns).toEqual([0, 11, 22]);
    expect(recentTurns).toEqual([0, 26]);
  });

  it('a reset reopens the window, so the next prompt prints the held pin again', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'compacted', project: PROJECT_P });
    const printedHash = first.staticHash ?? undefined;
    expect((await promptHookContext(ctx, { sessionId: 'compacted', project: PROJECT_P, printedHash })).stdout).toBe('');
    bookReset(store, 'compacted');
    expect((await promptHookContext(ctx, { sessionId: 'compacted', project: PROJECT_P, printedHash })).stdout).toBe(first.stdout);
  });

  it('an older binary\'s hook row, which carries no keys, never holds a part back', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const probe = await promptHookContext(ctx, { sessionId: 'probe', project: PROJECT_P });
    withDb(store, (db) => recordTokenUse(db, {
      tenantId: 'default', sessionId: 'old-binary', surface: 'hook', event: 'inject', items: 1, tokens: 10, hash: probe.staticHash,
    }));
    const printedHash = probe.staticHash ?? undefined;
    expect((await promptHookContext(ctx, { sessionId: 'old-binary', project: PROJECT_P, printedHash })).stdout).toBe(probe.stdout);
  });

  it('prints every part on every prompt with skipUnchanged off, and books no marks', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ pinnedInject: { skipUnchanged: false } }));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'off', project: PROJECT_P });
    expect(await promptHookContext(ctx, { sessionId: 'off', project: PROJECT_P, printedHash: first.staticHash ?? undefined })).toEqual(first);
    expect(sentKeys(store, 'off')).toEqual([null, null]);
  });

  it('books no skip row for a well-formed hash the caller never got', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'wrong', project: PROJECT_P });
    const printedHash = first.staticHash === '0123456789abcdef' ? 'fedcba9876543210' : '0123456789abcdef';
    expect(await promptHookContext(ctx, { sessionId: 'wrong', project: PROJECT_P, printedHash })).toEqual(first);
    expect(ledger(store, `event = 'skip'`)).toEqual([]);
  });

  it('still resends an acknowledged pin after refreshTurns skips', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ pinnedInject: { refreshTurns: 2 } }));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const first = await promptHookContext(ctx, { sessionId: 'refresh', project: PROJECT_P });
    const printedHash = first.staticHash ?? undefined;
    const sent: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      sent.push((await promptHookContext(ctx, { sessionId: 'refresh', project: PROJECT_P, printedHash })).stdout !== '');
    }
    expect(sent).toEqual([false, false, true, false]);
  });

  it.each([
    ['upper case', '0123456789ABCDEF'],
    ['15 characters', '0123456789abcde'],
    ['17 characters', '0123456789abcdef0'],
    ['a non-hex letter', '0123456789abcdeg'],
  ])('rejects a printed hash in %s as a bad request', async (_name, printedHash) => {
    const store = makeProject(path.join(tmp, 'p'));
    await expect(promptHookContext(ctxFor(store), { sessionId: 's', project: PROJECT_P, printedHash })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('gives a sub-agent the whole block, though its parent\'s window holds it, and no hash to record', async () => {
    const store = makeProject(path.join(tmp, 'p'), 0);
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const ctx = ctxFor(store);
    const parent = await promptHookContext(ctx, { sessionId: 'parent', project: PROJECT_P });
    const printedHash = parent.staticHash ?? undefined;
    expect((await promptHookContext(ctx, { sessionId: 'parent', project: PROJECT_P, printedHash })).stdout).toBe('');
    const sub = await promptHookContext(ctx, { sessionId: 'parent', project: PROJECT_P, payload: { session_id: 'parent', agent_id: 'a1' } });
    expect(sub.stdout).toContain('rollback plan');
    expect(sub.staticHash).toBeNull();
  });

  it('books a caller arm row even when another tenant already holds that session id', async () => {
    const store = makeProject(path.join(tmp, 'p'), 10000);
    for (const tenantId of ['t-a', 't-b']) {
      const ctx: FullContext = apiCtx(store, tenantId, adminActor('prompt-hook-test'));
      expect((await promptHookContext(ctx, { sessionId: 'same-id', project: PROJECT_P })).arm).toBe('holdout');
    }
    expect(ledger(store, `event = 'arm'`).map((r) => r.tenant_id)).toEqual(['t-a', 't-b']);
  });

  it.each([
    ['a long session id', { sessionId: 'x'.repeat(MAX_ID_LEN + 1), project: PROJECT_P }],
    ['a long project name', { sessionId: 's', project: { ...PROJECT_P, name: 'n'.repeat(MAX_ID_LEN + 1) } }],
    ['a long alias', { sessionId: 's', project: { ...PROJECT_P, aliases: ['a'.repeat(MAX_ID_LEN + 1)] } }],
    ['eleven aliases', { sessionId: 's', project: { ...PROJECT_P, aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) } }],
  ])('rejects %s as a bad request', async (_name, req) => {
    const store = makeProject(path.join(tmp, 'p'));
    await expect(promptHookContext(ctxFor(store), req)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('takes ten aliases at the length cap', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const aliases = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(MAX_ID_LEN, 'a'));
    expect((await promptHookContext(ctxFor(store), { sessionId: 's', project: { ...PROJECT_P, aliases } })).stdout).toContain('rollback plan');
  });
});

describe('promptHookContext on a shared store', () => {
  const SHARED = { sharedStore: true } as const;
  const ask = (store: string, sessionId: string, shared: boolean): Promise<{ arm: string | null; stdout: string }> =>
    promptHookContext(ctxFor(store), { sessionId, project: PROJECT_P }, shared ? SHARED : undefined);

  it('keeps only the caller project rows in the recent tail; pins are unchanged', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: the user-global pin about the rollback plan', '');
    writeEntry(store, { ...createMemory('Kafka consumers in the billing service must be paused with kafka-pause.sh first'), origin_project: 'p' });
    writeEntry(store, { ...createMemory('Somebody keeps personal shell aliases in the dotfiles repo on the build box'), origin_project: '' });
    const own = await ask(store, 'tail-own', false);
    expect(own.stdout).toContain('dotfiles');
    const shared = await ask(store, 'tail-shared', true);
    expect(shared.stdout).toContain('kafka-pause.sh');
    expect(shared.stdout).toContain('user-global pin');
    expect(shared.stdout).not.toContain('dotfiles');
  });

  it('leaves out the global store of the user running the server', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const globalStore = path.join(tmp, 'global');
    initStore(globalStore);
    pin(globalStore, 'PINNED: the operator keeps a personal note about the vpn', '');
    expect((await ask(store, 'g-own', false)).stdout).toContain('personal note');
    const shared = await ask(store, 'g-shared', true);
    expect(shared.stdout).toContain('rollback plan');
    expect(shared.stdout).not.toContain('personal note');
  });

  it('shows task state only to the owner that saved it, in any of its sessions', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    saveActiveTaskSnapshot(store, 'default', { task: 'ship', summary: 'half done', next_step: 'run tests', session_id: 'owner' }, { owner: 'prompt-hook-test', project: ['p'] });
    expect((await ask(store, 'someone-else', false)).stdout).toContain('Active Task Snapshot');
    const otherCtx: FullContext = { ...ctxFor(store), actor: { subject: 'api_key:hk_other', role: 'member' } };
    const other = await promptHookContext(otherCtx, { sessionId: 'someone-else-shared', project: PROJECT_P }, SHARED);
    expect(other.stdout).toContain('rollback plan');
    expect(other.stdout).not.toContain('Active Task Snapshot');
    expect((await ask(store, 'owner-next-session', true)).stdout).toContain('Active Task Snapshot');
  });

  it('marks each send with the caller\'s owner, so another owner on the same session id still gets the block', async () => {
    const store = makeProject(path.join(tmp, 'p'));
    pin(store, 'PINNED: always check the rollback plan', 'p');
    const first = await promptHookContext(ctxFor(store), { sessionId: 'same', project: PROJECT_P }, SHARED);
    expect(sentKeys(store, 'same')).toEqual([{ pending: [expect.stringMatching(/^mem:[^:]+:[0-9a-f]{16}@prompt-hook-test$/)] }]);
    const otherCtx: FullContext = { ...ctxFor(store), actor: { subject: 'api_key:hk_other', role: 'member' } };
    const other = await promptHookContext(otherCtx, { sessionId: 'same', project: PROJECT_P, printedHash: first.staticHash ?? undefined }, SHARED);
    expect(other.stdout).toContain('rollback plan');
  });

  it('records nothing and books no arm when the served root has no store, never falling back to the global one', async () => {
    const globalStore = makeProject(path.join(tmp, 'home'), 10000);
    process.env.HIPPO_HOME = globalStore;
    const served = path.join(tmp, 'srv', '.hippo');
    expect(await ask(served, 'no-store', true)).toEqual({ arm: null, ...NOTHING });
    expect(ledger(globalStore, '1 = 1')).toEqual([]);
    expect(fs.existsSync(path.join(served, 'hippo.db'))).toBe(false);
    expect((await ask(served, 'no-store', false)).arm).toBe('holdout');
    expect(ledger(globalStore, `event = 'arm'`).map((r) => r.session_id)).toEqual(['no-store']);
  });
});

describe('subpath exports resolve', () => {
  it.each([
    ['hippo-memory/project-identity', 'resolveProjectIdentity', 'function'],
    ['hippo-memory/project-identity', 'MAX_PROJECT_ALIASES', 'number'],
    ['hippo-memory/project-identity', 'MCP_PROJECT_SCOPED_HEADER', 'string'],
    ['hippo-memory/project-identity', 'originInSql', 'undefined'],
    ['hippo-memory/project-identity', 'clearProjectIdentityCache', 'undefined'],
    ['hippo-memory/json-hooks', 'installJsonHooks', 'function'],
    ['hippo-memory/json-hooks', 'uninstallJsonHooks', 'function'],
    ['hippo-memory/json-hooks', 'resolveJsonHookPaths', 'function'],
    ['hippo-memory/json-hooks', 'readJsonFile', 'function'],
    ['hippo-memory/json-hooks', 'writeSettingsFile', 'function'],
    ['hippo-memory/json-hooks', 'checkUninstallable', 'undefined'],
    ['hippo-memory/server', 'promptHookContext', 'function'],
    ['hippo-memory/server', 'HttpError', 'function'],
    ['hippo-memory/server', 'captureSessionTexts', 'function'],
    ['hippo-memory/session-text', 'collectSessionTurns', 'function'],
    ['hippo-memory/session-text', 'sessionTail', 'function'],
    ['hippo-memory/session-text', 'scrubForSharing', 'function'],
    ['hippo-memory/session-text', 'transcriptWorkingState', 'function'],
    ['hippo-memory/session-text', 'WORKING_STATE_CAPS', 'object'],
    ['hippo-memory/session-text', 'lessonFromFailure', 'function'],
    ['hippo-memory/session-text', 'failureReport', 'function'],
    ['hippo-memory/session-text', 'collectHandoffEvidence', 'function'],
    ['hippo-memory/session-text', 'compactSummaryBody', 'function'],
    ['hippo-memory/session-text', 'parseCompactionItems', 'function'],
    ['hippo-memory/session-text', 'COMPACTION_ITEM_MAX_CHARS', 'number'],
    ['hippo-memory/session-text', 'COMPACTION_ITEM_ROW_CAP', 'number'],
    ['hippo-memory/session-text', 'summariseTranscript', 'undefined'],
  ])('%s: typeof %s is %s in the build', (specifier, name, type) => {
    const script = `const m = await import('${specifier}'); console.log(typeof m.${name});`;
    // cwd is the checkout because self-reference resolves from the nearest package.json.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf-8', timeout: 30_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe(type);
  });
});
