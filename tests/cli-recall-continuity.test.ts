import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  initStore,
  writeEntry,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-recall-cont-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

interface RunResult {
  stdout: string;
  status: number;
}

function runHippo(args: string[]): RunResult {
  const globalDir = path.join(tmpDir, 'global');
  try {
    const stdout = execFileSync(process.execPath, [HIPPO_JS, ...args], {
      env: { ...process.env, HIPPO_HOME: globalDir },
      cwd: tmpDir,
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

function seedContinuity(): void {
  saveActiveTaskSnapshot(hippoDir, 'default', {
    task: 'Wire continuity into recall',
    summary: 'Plan reviewed twice. Implementation underway.',
    next_step: 'Land Task 4 CLI flag.',
    session_id: 'sess-recall-cont',
    source: 'test',
  });
  saveSessionHandoff(hippoDir, 'default', {
    version: 1,
    sessionId: 'sess-recall-cont',
    summary: 'Mid-task handoff.',
    nextAction: 'Resume on Task 4 step 2.',
    artifacts: ['src/cli.ts'],
  });
  appendSessionEvent(hippoDir, 'default', {
    session_id: 'sess-recall-cont',
    event_type: 'note',
    content: 'A trail event from the continuity test.',
    source: 'test',
  });
}

describe('hippo recall --continuity', () => {
  it('JSON: returns continuity alongside memories', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('memory about deploys', {}));
    seedContinuity();

    const r = runHippo(['recall', 'deploys', '--continuity', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.continuity).toBeDefined();
    expect(parsed.continuity.activeSnapshot.task).toBe('Wire continuity into recall');
    expect(parsed.continuity.sessionHandoff.nextAction).toBe('Resume on Task 4 step 2.');
    expect(parsed.continuity.recentSessionEvents).toHaveLength(1);
    expect(parsed.continuityTokens).toBeGreaterThan(0);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  it('text: prints snapshot/handoff/trail headings above the memory list', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('another deploy memo', {}));
    seedContinuity();

    const r = runHippo(['recall', 'deploy', '--continuity']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Task Snapshot');
    expect(r.stdout).toContain('Session Handoff');
    expect(r.stdout).toContain('Recent Session');
    // Snapshot heading comes BEFORE the "Found N memories" line.
    expect(r.stdout.indexOf('Active Task Snapshot')).toBeLessThan(
      r.stdout.indexOf('Found'),
    );
  });

  it('does not include continuity when flag is absent (hot path)', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('hot path memory', {}));
    seedContinuity();

    const r = runHippo(['recall', 'hot', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.continuity).toBeUndefined();
    expect(parsed.continuityTokens).toBeUndefined();
  });

  // codex round 2 P1: zero-result regression must surface continuity.
  it('zero-result JSON: continuity still present when no memories match', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', {}));
    seedContinuity();

    const r = runHippo(['recall', 'totallyabsent_xyzzy', '--continuity', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.continuity).toBeDefined();
    expect(parsed.continuity.activeSnapshot.task).toBe('Wire continuity into recall');
  });

  it('zero-result text: prints continuity instead of bare "No memories found"', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', {}));
    seedContinuity();

    const r = runHippo(['recall', 'totallyabsent_xyzzy', '--continuity']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Task Snapshot');
    expect(r.stdout).toContain('Session Handoff');
    expect(r.stdout).toContain('(no memories matched');
    expect(r.stdout).not.toContain('No memories found for:');
  });

  it('zero-result without --continuity still prints "No memories found"', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', {}));
    seedContinuity();

    const r = runHippo(['recall', 'totallyabsent_xyzzy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No memories found for:');
    expect(r.stdout).not.toContain('Active Task Snapshot');
  });
});
