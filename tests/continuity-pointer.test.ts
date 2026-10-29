// Another session's task snapshot and handoff reach the text readers as a pointer to the command that prints them;
// the caller's own session, a shared store, JSON and the remote hook route (unless it opts in) get them whole.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { appendSessionEvent, saveActiveTaskSnapshot, type ContinuityKey } from '../src/store/sessions.js';
import { getContext, type ContextOpts } from '../src/api/index.js';
import { contextCost } from '../src/api/context-render.js';
import { promptHookContext } from '../src/api/prompt-hook.js';
import { sessionDigestId } from '../src/capture/session-digest.js';
import { SESSION_DIGEST_TAG } from '../src/core/session-digest-row.js';
import { Layer } from '../src/core/memory.js';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { handleContext } from '../src/cli/context.js';
import { handleHandoff, handleSession } from '../src/cli/continuity.js';
import type { CliFlags } from '../src/cli/flag-values.js';
import type { DeliveryObserver } from '../src/store/delivery-recorder.js';
import type { SessionHandoff } from '../src/core/handoff.js';
import type { TaskSnapshot } from '../src/store/rows.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';

const HANDOFF_SUMMARY = 'Moved the billing retries onto the queue; the dead-letter sweep still needs a dry run';
const NEXT_ACTION = 'dry-run the sweep';
const TASK = 'Move the billing retries to the queue';
const SNAPSHOT_SUMMARY = 'Retry worker is wired up; the dead-letter sweep is next';
const TRAIL_EVENT = 'Ran the sweep against staging and it timed out after thirty seconds';
const PROJECT = { name: 'p', legacyName: 'p' };
const HOOK_FLAGS: CliFlags = { 'pinned-only': true, 'include-recent': '5', format: 'additional-context' };
const PRIVATE_SCOPE = 'slack:private:Csecret';

const at = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

function handoffPointer(h: SessionHandoff): string {
  return `## Session Handoff\n\n- Session ${h.sessionId} left a handoff at ${at(h.updatedAt)} UTC. ` +
    `If this task continues it, run \`hippo handoff latest --session ${h.sessionId}\`.\n`;
}

function snapshotPointer(s: TaskSnapshot): string {
  return `## Active Task Snapshot\n\n- Session ${s.session_id} saved a task snapshot at ${at(s.updated_at)} UTC. ` +
    `If this task continues it, run \`hippo session latest --id ${s.session_id}\`.\n`;
}

function additionalContext(stdout: string): string {
  // SAFETY: the hook's stdout is the UserPromptSubmit reply hookReply builds.
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

/** Records each (shown, budget-dropped) pair the task sections report. */
function sectionsSpy() {
  const calls: Array<[number, number]> = [];
  const noop = (): void => undefined;
  const obs: DeliveryObserver = {
    facts: noop, qualityDropped: noop, disabled: noop, offer: noop, reject: noop, dropMissing: noop, gated: noop, selected: noop, queried: noop, traced: noop,
    sections: (shown, dropped) => { calls.push([shown, dropped]); },
    watchAdmit: (admit) => admit,
  };
  return { obs, calls };
}

describe('task state in a project store', () => {
  let tmp: string;
  let store: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-continuity-pointer-'));
    store = path.join(tmp, '.hippo');
    vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
    vi.stubEnv('HIPPO_TENANT', '');
    // The unknown-caller cases need no host id, and the others pass theirs in the payload.
    vi.stubEnv('HIPPO_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    initStore(store);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const saveHandoff = (sessionId: string, extra: Partial<SessionHandoff> = {}): SessionHandoff =>
    saveSessionHandoff(store, 'default', { version: 1, sessionId, summary: HANDOFF_SUMMARY, nextAction: NEXT_ACTION, ...extra });

  const saveSnapshot = (sessionId: string | null, extra: { summary?: string; scope?: string } = {}): TaskSnapshot =>
    saveActiveTaskSnapshot(store, 'default', {
      task: TASK, summary: SNAPSHOT_SUMMARY, next_step: 'run the sweep', session_id: sessionId, ...extra,
    });

  const logEvent = (sessionId: string, content = TRAIL_EVENT): void => {
    appendSessionEvent(store, 'default', { session_id: sessionId, event_type: 'note', content, source: 'test' });
  };

  /** `hippo context` in this process; no session id means no payload, so the caller is unknown. */
  async function cli(flags: CliFlags, sessionId?: string): Promise<string> {
    // No prompt, so the hook takes the recent-N path that surfaces a digest.
    const stdin = sessionId === undefined ? undefined : JSON.stringify({ session_id: sessionId });
    const r = await runInProcess(() => withHookStdin(stdin, () => handleContext({ hippoRoot: store, tenantId: 'default', args: [], flags })));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  const hookText = async (sessionId?: string): Promise<string> => additionalContext(await cli(HOOK_FLAGS, sessionId));
  const markdown = (sessionId?: string): Promise<string> => cli({ budget: '1500' }, sessionId);

  const remote = async (sessionId: string, opts?: { continuity: 'pointer' }): Promise<string> =>
    additionalContext((await promptHookContext(apiCtx(store), { sessionId, project: PROJECT }, opts)).stdout);

  const hookOpts = (budget: number, continuity?: ContextOpts['continuity'], sessionId = 'now'): ContextOpts =>
    ({ pinnedOnly: true, budget, cost: contextCost('additional-context', 'observe'), currentSessionId: sessionId, continuity });

  describe("another session's handoff", () => {
    it.each([
      ['promptHookContext with continuity: pointer', () => remote('now', { continuity: 'pointer' })],
      ['the CLI hook format', () => hookText('now')],
      ['hippo context markdown', () => markdown('now')],
    ])('prints the pointer from %s, and no summary text', async (_name, read) => {
      const handoff = saveHandoff('earlier');
      const text = await read();
      expect(text).toContain(handoffPointer(handoff));
      expect(text).not.toContain(HANDOFF_SUMMARY);
      expect(text).not.toContain(NEXT_ACTION);
      expect(text).not.toContain('- Session: earlier');
    });

    it("prints a pointer short enough to be worth sending", async () => {
      const handoff = saveHandoff('earlier');
      expect(handoffPointer(handoff).length).toBeLessThan(220);
    });
  });

  describe("another session's snapshot", () => {
    it('prints the pointer with no trail, though that session logged events, and the budget drops nothing', async () => {
      const snapshot = saveSnapshot('earlier');
      logEvent('earlier');
      logEvent('earlier', `${TRAIL_EVENT}; the retry is the only step left`);

      const text = await hookText('now');
      expect(text).toContain(snapshotPointer(snapshot));
      expect(text).not.toContain(SNAPSHOT_SUMMARY);
      expect(text).not.toContain('Recent Session Trail');
      expect(text).not.toContain(TRAIL_EVENT);

      // A budget the whole trail cannot fit: as a pointer it never reaches the purse, so nothing counts as dropped.
      const pointer = sectionsSpy();
      const result = await getContext(apiCtx(store), { ...hookOpts(150, 'pointer'), deliveryObserver: pointer.obs });
      expect(result.snapshotMode).toBe('pointer');
      expect(result.recentEvents).toBeUndefined();
      expect(pointer.calls).toEqual([[1, 0]]);

      const full = sectionsSpy();
      const whole = await getContext(apiCtx(store), { ...hookOpts(150, 'full'), deliveryObserver: full.obs });
      expect(whole.recentEvents).toBeUndefined();
      expect(full.calls.at(-1)?.[1]).toBeGreaterThan(0);
    });

    it('names no session when the snapshot has none, and points at `hippo snapshot show`', async () => {
      const snapshot = saveSnapshot(null);
      const text = await hookText('now');
      expect(text).toContain(
        `## Active Task Snapshot\n\n- A task snapshot from ${at(snapshot.updated_at)} UTC names no session. ` +
          'If this task continues it, run `hippo snapshot show`.\n',
      );
      expect(text).not.toContain('hippo session latest');
      expect(text).not.toContain(SNAPSHOT_SUMMARY);
    });

    it("prints nothing of another session's trail when its raw snapshot is scope-hidden", async () => {
      saveSnapshot('earlier', { scope: PRIVATE_SCOPE });
      logEvent('earlier');

      const whole = await getContext(apiCtx(store), hookOpts(1500, 'full'));
      expect(whole.activeSnapshot).toBeUndefined();
      expect(whole.recentEvents).toHaveLength(1);

      const pointer = await getContext(apiCtx(store), hookOpts(1500, 'pointer'));
      expect(pointer.activeSnapshot).toBeUndefined();
      expect(pointer.snapshotMode).toBeUndefined();
      expect(pointer.recentEvents).toBeUndefined();
      // Nothing else is left to print, so the hook sends nothing at all.
      expect(await cli(HOOK_FLAGS, 'now')).toBe('');
    });
  });

  describe("the caller's own session", () => {
    it('prints its own handoff, snapshot and trail in full', async () => {
      saveSnapshot('own');
      saveHandoff('own');
      logEvent('own');
      for (const read of [() => hookText('own'), () => remote('own', { continuity: 'pointer' })]) {
        const text = await read();
        expect(text).toContain('- Session: own');
        expect(text).toContain(`- Task: ${TASK}`);
        expect(text).toContain(SNAPSHOT_SUMMARY);
        expect(text).toContain(HANDOFF_SUMMARY);
        expect(text).toContain(TRAIL_EVENT);
        expect(text).not.toContain('hippo session latest');
        expect(text).not.toContain('hippo handoff latest');
      }
      const result = await getContext(apiCtx(store), hookOpts(1500, 'pointer', 'own'));
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });

    it('keeps its trail when its own snapshot is scope-hidden', async () => {
      saveSnapshot('own', { scope: PRIVATE_SCOPE });
      logEvent('own');
      const result = await getContext(apiCtx(store), hookOpts(1500, 'pointer', 'own'));
      expect(result.activeSnapshot).toBeUndefined();
      expect(result.recentEvents).toHaveLength(1);
      expect(await hookText('own')).toContain(TRAIL_EVENT);
    });
  });

  describe('an unknown caller', () => {
    it('gets pointers, and the text never says "Another session"', async () => {
      const snapshot = saveSnapshot('earlier');
      const handoff = saveHandoff('earlier');
      logEvent('earlier');
      for (const text of [await hookText(), await markdown()]) {
        expect(text).toContain(snapshotPointer(snapshot));
        expect(text).toContain(handoffPointer(handoff));
        expect(text).not.toContain('Another session');
        expect(text).not.toContain(HANDOFF_SUMMARY);
        expect(text).not.toContain(SNAPSHOT_SUMMARY);
        expect(text).not.toContain(TRAIL_EVENT);
      }
    });

    it('treats an empty session id as unknown, even for a snapshot with an empty id', async () => {
      saveSnapshot('');
      const result = await getContext(apiCtx(store), hookOpts(1500, 'pointer', ''));
      expect(result.snapshotMode).toBe('pointer');
    });
  });

  it('prints both pointers when one session left a fresh snapshot and a handoff', async () => {
    const snapshot = saveSnapshot('earlier');
    const handoff = saveHandoff('earlier');
    const text = await hookText('now');
    expect(text).toContain(snapshotPointer(snapshot));
    expect(text).toContain(handoffPointer(handoff));
    expect(text.indexOf('## Active Task Snapshot')).toBeLessThan(text.indexOf('## Session Handoff'));
  });

  describe('the budget', () => {
    it("charges each handoff pointer's size, so a handoff too long to print whole still points", async () => {
      const long = saveHandoff('long', { summary: `${HANDOFF_SUMMARY}. `.repeat(30) });
      const full = await getContext(apiCtx(store), hookOpts(150, 'full'));
      expect(full.sessionHandoff).toBeUndefined();
      const pointer = await getContext(apiCtx(store), hookOpts(150, 'pointer'));
      expect(pointer.sessionHandoff?.sessionId).toBe(long.sessionId);
      expect(pointer.handoffMode).toBe('pointer');
    });

    it("charges each snapshot pointer's size, so a snapshot too long to print whole still points", async () => {
      const long = saveSnapshot('long', { summary: `${SNAPSHOT_SUMMARY}. `.repeat(30) });
      const full = await getContext(apiCtx(store), hookOpts(150, 'full'));
      expect(full.activeSnapshot).toBeUndefined();
      const pointer = await getContext(apiCtx(store), hookOpts(150, 'pointer'));
      expect(pointer.activeSnapshot?.id).toBe(long.id);
      expect(pointer.snapshotMode).toBe('pointer');
    });

    it('shows no section, and sets no mode, when the budget is too small even for the pointers', async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      const result = await getContext(apiCtx(store), hookOpts(30, 'pointer'));
      expect(result.activeSnapshot).toBeUndefined();
      expect(result.sessionHandoff).toBeUndefined();
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });
  });

  describe('the readers that print the full text', () => {
    it('keeps it in JSON and in getContext without the opt-in', async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      // SAFETY: --format json prints the context JSON whose two task sections are a TaskSnapshot and a SessionHandoff.
      const json = JSON.parse(await cli({ budget: '1500', format: 'json' }, 'now')) as { activeSnapshot: TaskSnapshot; sessionHandoff: SessionHandoff };
      expect(json.activeSnapshot.summary).toBe(SNAPSHOT_SUMMARY);
      expect(json.sessionHandoff.summary).toBe(HANDOFF_SUMMARY);
      const result = await getContext(apiCtx(store), hookOpts(1500));
      expect(result.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });

    it('keeps it in promptHookContext unless its caller opts in', async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      const text = await remote('now');
      expect(text).toContain('- Session: earlier');
      expect(text).toContain(SNAPSHOT_SUMMARY);
      expect(text).toContain(HANDOFF_SUMMARY);
      expect(text).not.toContain('hippo session latest');
      expect(text).not.toContain('hippo handoff latest');
    });
  });

  describe('the digest of a session a pointer names', () => {
    const digest = (key: string, content: string) => ({
      ...createMemory(content, {
        layer: Layer.Episodic, tags: [SESSION_DIGEST_TAG], source: SESSION_DIGEST_TAG, confidence: 'observed', sourceSessionId: key,
      }),
      id: sessionDigestId('default', key),
      origin_project: '',
    });

    it('stays hidden, while the digest of a session no handoff names still shows', async () => {
      writeEntry(store, digest('earlier', 'Raised the upload timeout in `upload.ts` because large files need more than thirty seconds.\nChanged: src/upload.ts'));
      writeEntry(store, digest('older', 'Split the queue worker in `queue.ts` so slow jobs no longer block quick ones.\nChanged: src/queue.ts'));
      const handoff = saveHandoff('earlier', { evidence: { derivedFrom: 'transcript' } });
      const text = await hookText('now');
      expect(text).toContain(handoffPointer(handoff));
      expect(text).not.toContain('upload timeout');
      expect(text).toContain('queue worker');
    });
  });

  describe('the commands a pointer names', () => {
    it('print the full text: hippo session latest --id and hippo handoff latest --session', async () => {
      const snapshot = saveSnapshot('earlier');
      const handoff = saveHandoff('earlier');
      logEvent('earlier');
      const run = (fn: typeof handleSession, args: string[], flags: CliFlags) =>
        runInProcess(() => fn({ hippoRoot: store, tenantId: 'default', args, flags }));

      const session = await run(handleSession, ['latest'], { id: 'earlier' });
      expect(session.status, session.stderr).toBe(0);
      expect(session.stdout).toContain(`- Task: ${snapshot.task}`);
      expect(session.stdout).toContain(SNAPSHOT_SUMMARY);
      expect(session.stdout).toContain(TRAIL_EVENT);

      const latest = await run(handleHandoff, ['latest'], { session: handoff.sessionId });
      expect(latest.status, latest.stderr).toBe(0);
      expect(latest.stdout).toContain('- Session: earlier');
      expect(latest.stdout).toContain(HANDOFF_SUMMARY);
      expect(latest.stdout).toContain(NEXT_ACTION);
    });
  });
});

describe('task state on a shared store', () => {
  const KEY: ContinuityKey = { owner: 'bob', project: ['p'] };
  let home: string;

  beforeEach(() => {
    _resetSharedStoreCacheForTests();
    home = makeRoot('continuity-pointer-shared', { config: { sharedStore: true } });
  });

  afterEach(() => {
    _resetSharedStoreCacheForTests();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps the full text under continuity: pointer, because it follows its owner and a local command cannot reach it', async () => {
    saveActiveTaskSnapshot(home, 'default', { task: TASK, summary: SNAPSHOT_SUMMARY, next_step: 'run the sweep', session_id: 'sb1' }, KEY);
    saveSessionHandoff(home, 'default', { version: 1, sessionId: 'sb1', summary: HANDOFF_SUMMARY, nextAction: NEXT_ACTION }, KEY);
    const ctx = apiCtx(home, 'default', { subject: 'api_key:hk_bob', role: 'member', owner: 'bob' });

    const result = await getContext(ctx, {
      pinnedOnly: true, budget: 1500, currentProject: PROJECT, currentSessionId: 'sb2', cost: contextCost('additional-context', 'observe'), continuity: 'pointer',
    });
    expect(result.activeSnapshot?.summary).toBe(SNAPSHOT_SUMMARY);
    expect(result.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);
    expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);

    const hook = additionalContext((await promptHookContext(ctx, { sessionId: 'sb2', project: PROJECT }, { continuity: 'pointer' })).stdout);
    expect(hook).toContain(SNAPSHOT_SUMMARY);
    expect(hook).not.toContain('hippo session latest');
  });
});
