// A caller that renders compact-resume itself must hand the model the same bytes the local hook prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initProject, removeScratch, runHippo, scratch, type Scratch } from './_helpers/compaction-hooks.js';
import { listSessionEvents, loadActiveTaskSnapshot } from '../src/store/sessions.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, compactResumeText } from '../src/context-render.js';
import { truncateCodePointSafe } from '../src/transcript-tail.js';
import { resolveTenantId } from '../src/tenant.js';

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
