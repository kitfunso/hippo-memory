// Another session's task snapshot and handoff reach the text readers as a pointer to the command that prints them;
// the caller's own session, a shared store, JSON and the remote hook route (unless it opts in) get them whole.
// The per-prompt hook text leaves another session's handoff out; `hippo context` and `hippo handoff latest` print it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { contextGet } from '../../src/api/index.js';
import type { ContextOptions } from '../../src/api/context/context-types.js';
import { contextCost, handoffSectionText, snapshotSectionText } from '../../src/api/context/context-render.js';
import { buildPromptHookContext, type PromptHookOptions } from '../../src/api/prompt-hook.js';
import type { DeliveryObserver } from '../../src/api/delivery/delivery-recorder.js';
import { sessionDigestId, SESSION_DIGEST_TAG } from '../../src/base/session/session-digest-row.js';
import { Layer } from '../../src/base/memory/entry.js';
import { MAX_ID_LEN } from '../../src/base/util/limits.js';
import type { SessionHandoff } from '../../src/base/session/handoff.js';
import type { TaskSnapshot } from '../../src/base/ports/store/sessions.js';
import type { ContinuityKey } from '../../src/base/ports/store/types.js';
import { parseArgs } from '../../src/cli.js';
import { handleContext } from '../../src/surface/cli/context.js';
import { handleHandoff } from '../../src/surface/cli/handoff.js';
import { handleSession } from '../../src/surface/cli/session.js';
import type { CliFlags } from '../../src/surface/cli/flag-values.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { withHookStdin } from '../_helpers/hook-stdin.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { initTestStore } from '../_helpers/store-template.js';
import { appendSessionEvent, saveActiveTaskSnapshot, saveSessionHandoff, writeEntry } from '../_helpers/root-forms.js';

const HANDOFF_SUMMARY = 'Moved the billing retries onto the queue; the dead-letter sweep still needs a dry run';
const NEXT_ACTION = 'dry-run the sweep';
const TASK = 'Move the billing retries to the queue';
const SNAPSHOT_SUMMARY = 'Retry worker is wired up; the dead-letter sweep is next';
const TRAIL_EVENT = 'Ran the sweep against staging and it timed out after thirty seconds';
const PROJECT = { name: 'p', legacyName: 'p' };
const HOOK_FLAGS: CliFlags = { 'pinned-only': true, 'include-recent': '5', format: 'additional-context' };
const PRIVATE_SCOPE = 'slack:private:Csecret';
const UNSAFE_ID = 'a b; rm -rf x';

const at = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

function handoffPointer(h: SessionHandoff): string {
  return (
    `## Session Handoff\n\n- Session ${h.sessionId} left a handoff at ${at(h.updatedAt)} UTC. ` +
    `If this task continues it, run \`hippo handoff latest --session=${h.sessionId}\`.\n`
  );
}

function snapshotPointer(s: TaskSnapshot): string {
  return (
    `## Active Task Snapshot\n\n- Session ${s.sessionId} saved a task snapshot at ${at(s.updatedAt)} UTC. ` +
    `If this task continues it, run \`hippo session latest --id=${s.sessionId}\`.\n`
  );
}

function additionalContext(stdout: string): string {
  // SAFETY: the hook's stdout is the UserPromptSubmit reply hookReply builds.
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

/** Records each (shown, budget-dropped) pair the task sections report. */
function sectionsSpy() {
  const calls: Array<[number, number]> = [];
  const noop = (): void => undefined;
  const obs: DeliveryObserver = {
    facts: noop,
    filtered: noop,
    qualityDropped: noop,
    disabled: noop,
    offer: noop,
    reject: noop,
    dropMissing: noop,
    gated: noop,
    selected: noop,
    queried: noop,
    traced: noop,
    sections: (shown, dropped) => {
      calls.push([shown, dropped]);
    },
    watchAdmit: (admit) => admit,
  };
  return { obs, calls };
}

describe('task state in a project store', () => {
  let tmp: string;
  let store: string;

  beforeEach(() => {
    tmp = makeRoot('continuity-pointer', { init: false });
    store = path.join(tmp, '.hippo');
    vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
    vi.stubEnv('HIPPO_TENANT', '');
    // The unknown-caller cases need no host id, and the others pass theirs in the payload.
    vi.stubEnv('HIPPO_SESSION_ID', '');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    initTestStore(store);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const saveHandoff = (sessionId: string, extra: Partial<SessionHandoff> = {}): SessionHandoff =>
    saveSessionHandoff(store, 'default', {
      version: 1,
      sessionId,
      summary: HANDOFF_SUMMARY,
      nextAction: NEXT_ACTION,
      ...extra,
    });

  const saveSnapshot = (sessionId: string | null, extra: { summary?: string; scope?: string } = {}): TaskSnapshot =>
    saveActiveTaskSnapshot(store, 'default', {
      task: TASK,
      summary: SNAPSHOT_SUMMARY,
      nextStep: 'run the sweep',
      sessionId,
      ...extra,
    });

  const logEvent = async (sessionId: string, content = TRAIL_EVENT, scope?: string): Promise<void> => {
    await appendSessionEvent(store, 'default', { sessionId, eventType: 'note', content, source: 'test', scope });
  };

  /** `hippo context` in this process; no session id means no payload, so the caller is unknown. */
  async function cli(flags: CliFlags, sessionId?: string): Promise<string> {
    // No prompt, so the hook takes the recent-N path that surfaces a digest.
    const stdin = sessionId === undefined ? undefined : JSON.stringify({ session_id: sessionId });
    const r = await runInProcess(() =>
      withHookStdin(stdin, () => handleContext({ hippoRoot: store, tenantId: 'default', args: [], flags })),
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  const hookText = async (sessionId?: string): Promise<string> => {
    const stdout = await cli(HOOK_FLAGS, sessionId);
    // The hook prints nothing when no block is left to send.
    return stdout === '' ? '' : additionalContext(stdout);
  };
  const markdown = (sessionId?: string): Promise<string> => cli({ budget: '1500' }, sessionId);

  const remote = async (sessionId: string, opts?: PromptHookOptions): Promise<string> =>
    additionalContext((await buildPromptHookContext(apiCtx(store), { sessionId, project: PROJECT }, opts)).stdout);

  const hookOpts = (budget: number, continuity?: ContextOptions['continuity'], sessionId = 'now'): ContextOptions => ({
    pinnedOnly: true,
    budget,
    currentProject: PROJECT,
    cost: contextCost('additional-context', 'observe', new Date()),
    currentSessionId: sessionId,
    continuity,
  });

  describe("another session's handoff", () => {
    it.each([
      ['buildPromptHookContext with continuity: pointer', () => remote('now', { continuity: 'pointer' })],
      ['hippo context markdown', () => markdown('now')],
    ])('prints the pointer from %s, and no summary text', async (_name, read) => {
      const handoff = saveHandoff('earlier');
      const text = await read();
      expect(text).toContain(handoffPointer(handoff));
      expect(text).not.toContain(HANDOFF_SUMMARY);
      expect(text).not.toContain(NEXT_ACTION);
      expect(text).not.toContain('- Session: earlier');
    });

    it('is left out of the CLI hook text, pointer and summary alike, while the same session snapshot still prints', async () => {
      const snapshot = saveSnapshot('earlier');
      saveHandoff('earlier');
      const text = await hookText('now');
      expect(text).toContain(snapshotPointer(snapshot));
      expect(text).not.toContain('Session Handoff');
      expect(text).not.toContain('hippo handoff latest');
      expect(text).not.toContain(HANDOFF_SUMMARY);
      expect(text).not.toContain(NEXT_ACTION);
    });

    it("counts a handoff the option leaves out as neither shown nor dropped, so the sections report is the snapshot's alone", async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      const spy = sectionsSpy();
      const result = await contextGet(apiCtx(store), {
        ...hookOpts(1500, 'pointer'),
        ownHandoffOnly: true,
        deliveryObserver: spy.obs,
      });
      expect(result.sessionHandoff).toBeUndefined();
      expect(result.handoffMode).toBeUndefined();
      expect(spy.calls).toEqual([[1, 0]]);
    });

    it('is printed by the hook text to the session that left it', async () => {
      saveHandoff('own');
      const text = await hookText('own');
      expect(text).toContain('- Session: own');
      expect(text).toContain(HANDOFF_SUMMARY);
      expect(text).toContain(NEXT_ACTION);
      expect(text).not.toContain('hippo handoff latest');
    });

    it('is left out of the hook text for a caller with no session id, though the pointer readers name it', async () => {
      const handoff = saveHandoff('earlier');
      expect(await hookText()).toBe('');
      expect(await markdown()).toContain(handoffPointer(handoff));
    });

    it("a newer handoff from another session hides the caller's own (known limit, decision 2026-11-01)", async () => {
      // No fresh snapshot, so the read returns the newest handoff of any session; row id breaks a same-millisecond tie.
      const own = saveHandoff('own', { summary: 'Unfinished: the caller left this one first' });
      const newer = saveHandoff('earlier', { summary: 'Unfinished: a parallel session left this one later' });
      const text = await hookText('own');
      expect(text).not.toContain('Session Handoff');
      expect(text).not.toContain(own.summary);
      expect(text).not.toContain(newer.summary);
      const full = await markdown('own');
      expect(full).toContain(handoffPointer(newer));
      expect(full).not.toContain(own.summary);
    });

    it('is still printed as a pointer by `--pinned-only --format copilot`, the one injection Copilot gets', async () => {
      const handoff = saveHandoff('earlier');
      const text = additionalContext(
        await cli({ 'pinned-only': true, 'include-recent': '5', format: 'copilot' }, 'now'),
      );
      expect(text).toContain(handoffPointer(handoff));
      expect(text).not.toContain(HANDOFF_SUMMARY);
    });

    it('is still returned whole by `--pinned-only --format json`', async () => {
      saveHandoff('earlier');
      const out = await cli({ 'pinned-only': true, 'include-recent': '5', format: 'json' }, 'now');
      // SAFETY: --format json prints the context JSON whose handoff section is a SessionHandoff.
      const json = JSON.parse(out) as { sessionHandoff: SessionHandoff };
      expect(json.sessionHandoff.sessionId).toBe('earlier');
      expect(json.sessionHandoff.summary).toBe(HANDOFF_SUMMARY);
    });

    it('is printed by buildPromptHookContext unless its caller opts in, and then matches the CLI hook text', async () => {
      const snapshot = saveSnapshot('earlier');
      const handoff = saveHandoff('earlier');
      // The CLI first: a buildPromptHookContext call books a ledger row that would make the CLI skip the same block.
      const cliText = await hookText('now');
      expect(cliText).toContain(snapshotPointer(snapshot));
      expect(cliText).not.toContain('Session Handoff');
      expect(await remote('now', { continuity: 'pointer', ownHandoffOnly: true })).toBe(cliText);

      expect(await remote('now', { continuity: 'pointer' })).toContain(handoffPointer(handoff));
      expect(await remote('now')).toContain(HANDOFF_SUMMARY);
    });

    it('prints a pointer short enough to be worth sending', () => {
      expect(handoffSectionText(saveHandoff('earlier'), 'pointer').length).toBeLessThan(220);
    });

    it.each([
      ['unsafe to paste into a command', UNSAFE_ID],
      ['longer than the id cap', 'x'.repeat(MAX_ID_LEN + 1)],
      ['empty, so no command can name the row', ''],
    ])('prints the whole handoff, and no command, when its session id is %s', async (_name, id) => {
      saveHandoff(id);
      const text = await markdown('now');
      expect(text).toContain(`- Session: ${id}`);
      expect(text).toContain(HANDOFF_SUMMARY);
      expect(text).toContain(NEXT_ACTION);
      expect(text).not.toContain('hippo handoff latest');
      const result = await contextGet(apiCtx(store), hookOpts(1500, 'pointer'));
      expect(result.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);
      expect(result.handoffMode).toBeUndefined();
      // Another session's handoff stays out of the hook text whatever its id.
      expect(await hookText('now')).not.toContain(HANDOFF_SUMMARY);
    });

    it('names a normal session id with letters, digits, hyphens and underscores', async () => {
      const handoff = saveHandoff('sess-1_x');
      expect(await markdown('now')).toContain(handoffPointer(handoff));
    });
  });

  describe("another session's snapshot", () => {
    it('prints the pointer with no trail, though that session logged events, and the budget drops nothing', async () => {
      const snapshot = saveSnapshot('earlier');
      await logEvent('earlier');
      await logEvent('earlier', `${TRAIL_EVENT}; the retry is the only step left`);

      const text = await hookText('now');
      expect(text).toContain(snapshotPointer(snapshot));
      expect(text).not.toContain(SNAPSHOT_SUMMARY);
      expect(text).not.toContain('Recent Session Trail');
      expect(text).not.toContain(TRAIL_EVENT);

      // A budget the whole trail cannot fit: as a pointer it never reaches the purse, so nothing counts as dropped.
      const pointer = sectionsSpy();
      const result = await contextGet(apiCtx(store), { ...hookOpts(150, 'pointer'), deliveryObserver: pointer.obs });
      expect(result.snapshotMode).toBe('pointer');
      expect(result.recentEvents).toBeUndefined();
      expect(pointer.calls).toEqual([[1, 0]]);

      const full = sectionsSpy();
      const whole = await contextGet(apiCtx(store), { ...hookOpts(150, 'full'), deliveryObserver: full.obs });
      expect(whole.recentEvents).toBeUndefined();
      expect(full.calls.at(-1)?.[1]).toBeGreaterThan(0);
    });

    it('names no session when the snapshot has none, and points at `hippo snapshot show`', async () => {
      const snapshot = saveSnapshot(null);
      const text = await hookText('now');
      expect(text).toContain(
        `## Active Task Snapshot\n\n- A task snapshot from ${at(snapshot.updatedAt)} UTC names no session. ` +
          'If this task continues it, run `hippo snapshot show`.\n',
      );
      expect(text).not.toContain('hippo session latest');
      expect(text).not.toContain(SNAPSHOT_SUMMARY);
    });

    it('prints a pointer short enough to be worth sending', () => {
      expect(snapshotSectionText(saveSnapshot('earlier'), 'pointer').length).toBeLessThan(220);
    });

    it.each([
      ['unsafe to paste into a command', UNSAFE_ID],
      ['longer than the id cap', 'x'.repeat(MAX_ID_LEN + 1)],
    ])('prints the whole snapshot and its trail, and no command, when its session id is %s', async (_name, id) => {
      saveSnapshot(id);
      await logEvent(id);
      const text = await hookText('now');
      expect(text).toContain(`- Session: ${id}`);
      expect(text).toContain(SNAPSHOT_SUMMARY);
      expect(text).toContain('Recent Session Trail');
      expect(text).toContain(TRAIL_EVENT);
      expect(text).not.toContain('hippo session latest');
      expect(text).not.toContain('hippo snapshot show');
      const result = await contextGet(apiCtx(store), hookOpts(1500, 'pointer'));
      expect(result.activeSnapshot?.summary).toBe(SNAPSHOT_SUMMARY);
      expect(result.snapshotMode).toBeUndefined();
      expect(result.recentEvents).toHaveLength(1);
    });

    it('names a normal session id with letters, digits, hyphens and underscores', async () => {
      const snapshot = saveSnapshot('sess-1_x');
      expect(await hookText('now')).toContain(snapshotPointer(snapshot));
    });

    // A pointer names a command, so a trail with no pointer printing it goes through the scope filter and the purse.
    it("prints another session's trail in full when its snapshot is scope-hidden, as without the opt-in", async () => {
      saveSnapshot('earlier', { scope: PRIVATE_SCOPE });
      await logEvent('earlier');
      await logEvent('earlier', 'Wrote the private sweep notes', PRIVATE_SCOPE);

      for (const continuity of ['full', 'pointer'] as const) {
        const result = await contextGet(apiCtx(store), hookOpts(1500, continuity));
        expect(result.activeSnapshot, continuity).toBeUndefined();
        expect(result.snapshotMode, continuity).toBeUndefined();
        expect(
          result.recentEvents?.map((e) => e.content),
          continuity,
        ).toEqual([TRAIL_EVENT]);
      }
      const text = await hookText('now');
      expect(text).toContain('Recent Session Trail');
      expect(text).toContain(TRAIL_EVENT);
      expect(text).not.toContain('private sweep notes');
      expect(text).not.toContain(SNAPSHOT_SUMMARY);
      expect(text).not.toContain('hippo session latest');
    });

    it("prints another session's trail in full when the budget fits it but not the snapshot pointer", async () => {
      saveSnapshot('earlier');
      await logEvent('earlier', 'Sweep timed out');

      // At 49 tokens the 40-token pointer is dropped and the 37-token trail is paid; at 60 the pointer fits and hides it.
      const unpaid = sectionsSpy();
      const result = await contextGet(apiCtx(store), { ...hookOpts(49, 'pointer'), deliveryObserver: unpaid.obs });
      expect(result.activeSnapshot).toBeUndefined();
      expect(result.snapshotMode).toBeUndefined();
      expect(result.recentEvents?.map((e) => e.content)).toEqual(['Sweep timed out']);
      expect(unpaid.calls).toEqual([[1, 1]]);

      const paid = await contextGet(apiCtx(store), hookOpts(60, 'pointer'));
      expect(paid.snapshotMode).toBe('pointer');
      expect(paid.recentEvents).toBeUndefined();
    });
  });

  describe("the caller's own session", () => {
    it('prints its own handoff, snapshot and trail in full', async () => {
      saveSnapshot('own');
      saveHandoff('own');
      await logEvent('own');
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
      const result = await contextGet(apiCtx(store), hookOpts(1500, 'pointer', 'own'));
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });

    it('keeps its trail when its own snapshot is scope-hidden', async () => {
      saveSnapshot('own', { scope: PRIVATE_SCOPE });
      await logEvent('own');
      const result = await contextGet(apiCtx(store), hookOpts(1500, 'pointer', 'own'));
      expect(result.activeSnapshot).toBeUndefined();
      expect(result.recentEvents).toHaveLength(1);
      expect(await hookText('own')).toContain(TRAIL_EVENT);
    });
  });

  describe('an unknown caller', () => {
    it('gets pointers, and the text never says "Another session"', async () => {
      const snapshot = saveSnapshot('earlier');
      const handoff = saveHandoff('earlier');
      await logEvent('earlier');
      const hook = await hookText();
      const md = await markdown();
      for (const text of [hook, md]) {
        expect(text).toContain(snapshotPointer(snapshot));
        expect(text).not.toContain('Another session');
        expect(text).not.toContain(HANDOFF_SUMMARY);
        expect(text).not.toContain(SNAPSHOT_SUMMARY);
        expect(text).not.toContain(TRAIL_EVENT);
      }
      expect(md).toContain(handoffPointer(handoff));
      // No session id means no handoff is the caller's own, so the hook leaves them all out.
      expect(hook).not.toContain('Session Handoff');
    });

    it('treats an empty session id as unknown, even for a snapshot with an empty id', async () => {
      saveSnapshot('');
      const result = await contextGet(apiCtx(store), hookOpts(1500, 'pointer', ''));
      expect(result.snapshotMode).toBe('pointer');
    });
  });

  it('prints both pointers when one session left a fresh snapshot and a handoff', async () => {
    const snapshot = saveSnapshot('earlier');
    const handoff = saveHandoff('earlier');
    const text = await markdown('now');
    expect(text).toContain(snapshotPointer(snapshot));
    expect(text).toContain(handoffPointer(handoff));
    expect(text.indexOf('## Active Task Snapshot')).toBeLessThan(text.indexOf('## Session Handoff'));
  });

  describe('the budget', () => {
    it("charges each handoff pointer's size, so a handoff too long to print whole still points", async () => {
      const long = saveHandoff('long', { summary: `${HANDOFF_SUMMARY}. `.repeat(30) });
      const full = await contextGet(apiCtx(store), hookOpts(150, 'full'));
      expect(full.sessionHandoff).toBeUndefined();
      const pointer = await contextGet(apiCtx(store), hookOpts(150, 'pointer'));
      expect(pointer.sessionHandoff?.sessionId).toBe(long.sessionId);
      expect(pointer.handoffMode).toBe('pointer');
    });

    it("charges each snapshot pointer's size, so a snapshot too long to print whole still points", async () => {
      const long = saveSnapshot('long', { summary: `${SNAPSHOT_SUMMARY}. `.repeat(30) });
      const full = await contextGet(apiCtx(store), hookOpts(150, 'full'));
      expect(full.activeSnapshot).toBeUndefined();
      const pointer = await contextGet(apiCtx(store), hookOpts(150, 'pointer'));
      expect(pointer.activeSnapshot?.id).toBe(long.id);
      expect(pointer.snapshotMode).toBe('pointer');
    });

    it('shows no section, and sets no mode, when the budget is too small even for the pointers', async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      const result = await contextGet(apiCtx(store), hookOpts(30, 'pointer'));
      expect(result.activeSnapshot).toBeUndefined();
      expect(result.sessionHandoff).toBeUndefined();
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });
  });

  describe('the readers that print the full text', () => {
    it('keeps it in JSON and in contextGet without the opt-in', async () => {
      saveSnapshot('earlier');
      saveHandoff('earlier');
      // SAFETY: --format json prints the context JSON whose two task sections carry a summary each.
      const json = JSON.parse(await cli({ budget: '1500', format: 'json' }, 'now')) as {
        activeSnapshot: { summary: string };
        sessionHandoff: { summary: string };
      };
      expect(json.activeSnapshot.summary).toBe(SNAPSHOT_SUMMARY);
      expect(json.sessionHandoff.summary).toBe(HANDOFF_SUMMARY);
      const result = await contextGet(apiCtx(store), hookOpts(1500));
      expect(result.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);
      expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);
    });

    it('keeps it in buildPromptHookContext unless its caller opts in', async () => {
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
        layer: Layer.Episodic,
        tags: [SESSION_DIGEST_TAG],
        source: SESSION_DIGEST_TAG,
        confidence: 'observed',
        sourceSessionId: key,
      }),
      id: sessionDigestId('default', key),
      originProject: '',
    });

    it('stays hidden, while the digest of a session no handoff names still shows', async () => {
      writeEntry(
        store,
        digest(
          'earlier',
          'Raised the upload timeout in `upload.ts` because large files need more than thirty seconds.\nChanged: src/upload.ts',
        ),
      );
      writeEntry(
        store,
        digest(
          'older',
          'Split the queue worker in `queue.ts` so slow jobs no longer block quick ones.\nChanged: src/queue.ts',
        ),
      );
      const handoff = saveHandoff('earlier', { evidence: { derivedFrom: 'transcript' } });
      const text = await hookText('now');
      expect(text).not.toContain('Session Handoff');
      expect(text).not.toContain('upload timeout');
      expect(text).toContain('queue worker');

      // The pointer readers still print the handoff in place of the digest.
      const pointer = await markdown('now');
      expect(pointer).toContain(handoffPointer(handoff));
      expect(pointer).not.toContain('upload timeout');
    });
  });

  describe('the commands a pointer names', () => {
    /** Runs the `hippo <verb> ...` line a pointer printed, through the CLI's own parser and the verb handler. */
    async function runPrinted(text: string, verb: 'session' | 'handoff') {
      const printed = [...text.matchAll(/run `hippo ([^`]+)`/g)].map((m) => m[1]).find((c) => c.startsWith(`${verb} `));
      expect(printed, text).toBeDefined();
      const { args, flags } = parseArgs(['node', 'hippo', ...printed!.split(' ')]);
      expect(flags['help'], printed).toBeUndefined();
      const handler = verb === 'session' ? handleSession : handleHandoff;
      const r = await runInProcess(() => handler({ hippoRoot: store, tenantId: 'default', args, flags }));
      expect(r.status, r.stderr).toBe(0);
      return { printed: printed!, stdout: r.stdout };
    }

    it('print the full text: hippo session latest --id=<id> and hippo handoff latest --session=<id>', async () => {
      const snapshot = saveSnapshot('earlier');
      saveHandoff('earlier');
      await logEvent('earlier');
      const text = await markdown('now');

      const session = await runPrinted(text, 'session');
      expect(session.printed).toBe('session latest --id=earlier');
      expect(session.stdout).toContain(`- Task: ${snapshot.task}`);
      expect(session.stdout).toContain(SNAPSHOT_SUMMARY);
      expect(session.stdout).toContain(TRAIL_EVENT);

      const latest = await runPrinted(text, 'handoff');
      expect(latest.printed).toBe('handoff latest --session=earlier');
      expect(latest.stdout).toContain('- Session: earlier');
      expect(latest.stdout).toContain(HANDOFF_SUMMARY);
      expect(latest.stdout).toContain(NEXT_ACTION);
    });

    it('read a session id that starts with -- as the id, not as a flag', async () => {
      const snapshot = saveSnapshot('--help');
      const handoff = saveHandoff('--help');
      await logEvent('--help');
      const text = await markdown('now');
      expect(text).toContain(snapshotPointer(snapshot));
      expect(text).toContain(handoffPointer(handoff));
      expect(text).toContain('`hippo session latest --id=--help`');
      expect(text).toContain('`hippo handoff latest --session=--help`');

      const session = await runPrinted(text, 'session');
      expect(session.stdout).toContain(SNAPSHOT_SUMMARY);
      expect(session.stdout).toContain(TRAIL_EVENT);
      expect(session.stdout).not.toContain('Usage');

      const latest = await runPrinted(text, 'handoff');
      expect(latest.stdout).toContain('- Session: --help');
      expect(latest.stdout).toContain(HANDOFF_SUMMARY);
      expect(latest.stdout).not.toContain('Usage');
    });

    it("return the very handoff the full print shows, though another session's finished handoff is newer", async () => {
      const unfinished = saveHandoff('earlier', { summary: 'Unfinished: the sweep still times out in staging' });
      saveHandoff('newer', { summary: 'Finished: the queue worker shipped', outcome: 'success' });

      const whole = await contextGet(apiCtx(store), hookOpts(1500, 'full'));
      expect(whole.sessionHandoff?.summary).toBe(unfinished.summary);

      const text = await markdown('now');
      expect(text).toContain(handoffPointer(unfinished));
      expect(await hookText('now')).not.toContain(unfinished.summary);
      const latest = await runPrinted(text, 'handoff');
      expect(latest.stdout).toContain(unfinished.summary);
      expect(latest.stdout).not.toContain('Finished: the queue worker shipped');
    });
  });
});

describe('task state on a shared store', () => {
  const KEY: ContinuityKey = { owner: 'bob', project: ['p'] };
  let home: string;

  beforeEach(() => {
    home = makeRoot('continuity-pointer-shared', { config: { sharedStore: true } });
  });

  /** Bob's snapshot and handoff, both left by session sb1. */
  function seedBob() {
    saveActiveTaskSnapshot(
      home,
      'default',
      { task: TASK, summary: SNAPSHOT_SUMMARY, nextStep: 'run the sweep', sessionId: 'sb1' },
      KEY,
    );
    saveSessionHandoff(
      home,
      'default',
      { version: 1, sessionId: 'sb1', summary: HANDOFF_SUMMARY, nextAction: NEXT_ACTION },
      KEY,
    );
    return apiCtx(home, 'default', { subject: 'api_key:hk_bob', role: 'member', owner: 'bob' });
  }

  it('keeps the full text under continuity: pointer, because it follows its owner and a local command cannot reach it', async () => {
    const ctx = seedBob();

    const result = await contextGet(ctx, {
      pinnedOnly: true,
      budget: 1500,
      currentProject: PROJECT,
      currentSessionId: 'sb2',
      cost: contextCost('additional-context', 'observe', new Date()),
      continuity: 'pointer',
    });
    expect(result.activeSnapshot?.summary).toBe(SNAPSHOT_SUMMARY);
    expect(result.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);
    expect([result.snapshotMode, result.handoffMode]).toEqual([undefined, undefined]);

    const hook = additionalContext(
      (await buildPromptHookContext(ctx, { sessionId: 'sb2', project: PROJECT }, { continuity: 'pointer' })).stdout,
    );
    expect(hook).toContain(SNAPSHOT_SUMMARY);
    expect(hook).not.toContain('hippo session latest');
  });

  it("drops another session's handoff under ownHandoffOnly, so the owner resumes it with `hippo context`, and keeps the snapshot", async () => {
    const ctx = seedBob();
    const opts: ContextOptions = {
      pinnedOnly: true,
      budget: 1500,
      currentProject: PROJECT,
      cost: contextCost('additional-context', 'observe', new Date()),
      continuity: 'pointer',
      ownHandoffOnly: true,
    };

    const other = await contextGet(ctx, { ...opts, currentSessionId: 'sb2' });
    expect(other.activeSnapshot?.summary).toBe(SNAPSHOT_SUMMARY);
    expect(other.sessionHandoff).toBeUndefined();
    const own = await contextGet(ctx, { ...opts, currentSessionId: 'sb1' });
    expect(own.sessionHandoff?.summary).toBe(HANDOFF_SUMMARY);

    const options: PromptHookOptions = { continuity: 'pointer', ownHandoffOnly: true };
    const hook = additionalContext(
      (await buildPromptHookContext(ctx, { sessionId: 'sb2', project: PROJECT }, options)).stdout,
    );
    expect(hook).toContain(SNAPSHOT_SUMMARY);
    expect(hook).not.toContain(HANDOFF_SUMMARY);
    expect(hook).not.toContain('hippo handoff latest');
  });
});
