// A caller's compaction must store the snapshot the local hook stores, and its resume must hand the model the bytes the local hook prints.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initProject, removeScratch, runHippo, scratch, type Scratch } from './_helpers/compaction-hooks.js';
import type { Context } from '../src/api/types.js';
import { transcriptWorkingState } from '../src/capture/working-state.js';
import { preCompactForCaller } from '../src/server.js';
import { initStore } from '../src/store/open.js';
import type { TaskSnapshot } from '../src/store/rows.js';
import { listSessionEvents, loadActiveTaskSnapshot } from '../src/store/sessions.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, compactResumeText } from '../src/api/context-render.js';
import { truncateCodePointSafe } from '../src/util/transcript-tail.js';
import { resolveTenantId } from '../src/store/tenant.js';

let s: Scratch;

beforeEach(() => {
  s = scratch();
  for (const name of ['HIPPO_HOME', 'HOME', 'USERPROFILE'] as const) vi.stubEnv(name, s.env[name]!);
  initProject(s);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeScratch(s);
});

function hippo(...args: string[]): void {
  const r = runHippo(args, s.proj, s.env);
  expect(r.status, r.stderr).toBe(0);
}

function resumeStdout(sessionId: string): string {
  const r = runHippo(['compact-resume'], s.proj, s.env, JSON.stringify({ session_id: sessionId, source: 'compact', cwd: s.proj }));
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

function expectedText(): string {
  const tenantId = resolveTenantId({});
  const snapshot = loadActiveTaskSnapshot(s.hippoRoot, tenantId);
  expect(snapshot).not.toBeNull();
  const events = snapshot!.session_id === null ? [] : listSessionEvents(s.hippoRoot, tenantId, { session_id: snapshot!.session_id })
    .map((e) => ({ ...e, content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP) }));
  return compactResumeText(snapshot!, events);
}

describe('compactResumeText', () => {
  it('equals the local compact-resume stdout byte for byte, with a trail', () => {
    hippo('snapshot', 'save', '--task', 'fix the flaky login test', '--summary', 'found the race', '--next-step', 'add the lock', '--session', 's1');
    hippo('session', 'log', '--id', 's1', '--content', 'ran the suite', '--type', 'note', '--task', 'login');
    hippo('session', 'log', '--id', 's1', '--content', `long ${'y'.repeat(COMPACT_RESUME_EVENT_CONTENT_CAP * 2)}`, '--type', 'note');
    const stdout = resumeStdout('s1');
    expect(stdout).toContain('## Recent Session Trail');
    expect(stdout).not.toContain('y'.repeat(COMPACT_RESUME_EVENT_CONTENT_CAP));
    expect(stdout).toBe(expectedText() + '\n');
  });

  it('equals the local compact-resume stdout byte for byte, without a trail', () => {
    hippo('snapshot', 'save', '--task', 'ship the report', '--summary', 'tables done', '--next-step', 'write the summary', '--session', 's2');
    const stdout = resumeStdout('s2');
    expect(stdout).toContain('## Restored after compaction');
    expect(stdout).not.toContain('Session Trail');
    expect(stdout).toBe(expectedText() + '\n');
  });
});

describe('preCompactForCaller', () => {
  it('stores the snapshot local pre-compact stores for the same transcript, email masked in both', () => {
    const email = 'dev@acme.io';
    const transcript = path.join(s.proj, 't.jsonl');
    const turns = [
      { type: 'user', message: { role: 'user', content: `Fix the flaky login test and mail ${email} once it passes.` } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Adding a lock around the session refresh.' }] } },
    ];
    fs.writeFileSync(transcript, turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
    const payload = { transcript_path: transcript, cwd: s.proj, hook_event_name: 'PreCompact', trigger: 'auto', session_id: 's1' };
    const r = runHippo(['pre-compact', '--log-file', path.join(s.dir, 'pre-compact.log')], s.proj, s.env, JSON.stringify(payload));
    expect(r.status, r.stderr).toBe(0);
    const local = loadActiveTaskSnapshot(s.hippoRoot, resolveTenantId({}));

    const server = path.join(s.dir, 'server', '.hippo');
    fs.mkdirSync(server, { recursive: true });
    initStore(server);
    fs.writeFileSync(path.join(server, 'config.json'), JSON.stringify({ sharedStore: true }));
    const ctx: Context = { hippoRoot: server, tenantId: 'acme', actor: { subject: 'api_key:hk_alice', role: 'member', owner: 'alice' } };
    preCompactForCaller(ctx, { sessionId: 's1', project: { name: 'proj', legacyName: 'proj' }, trigger: 'auto', workingState: transcriptWorkingState(transcript, () => {}) });
    const stored = loadActiveTaskSnapshot(server, 'acme', { owner: 'alice', project: ['proj'] });

    const fields = (x: TaskSnapshot | null) => ({ task: x?.task, summary: x?.summary, next_step: x?.next_step, source: x?.source, session_id: x?.session_id });
    expect(local?.task).toBe('Fix the flaky login test and mail [email] once it passes.');
    expect(fields(stored)).toEqual(fields(local));
  });
});
