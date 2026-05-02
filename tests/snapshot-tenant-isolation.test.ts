import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
} from '../src/store.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-snapshot-tenant-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('task_snapshot tenant isolation', () => {
  it('tenant B saving a snapshot does not supersede tenant A active row', () => {
    initStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A task',
      summary: 'A summary',
      next_step: 'A next',
      session_id: 'sess-a',
      source: 'test',
    });

    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B task',
      summary: 'B summary',
      next_step: 'B next',
      session_id: 'sess-b',
      source: 'test',
    });

    const aSnap = loadActiveTaskSnapshot(tmpDir, 'tenantA');
    const bSnap = loadActiveTaskSnapshot(tmpDir, 'tenantB');

    expect(aSnap).not.toBeNull();
    expect(aSnap!.task).toBe('A task');
    expect(aSnap!.status).toBe('active');

    expect(bSnap).not.toBeNull();
    expect(bSnap!.task).toBe('B task');
    expect(bSnap!.status).toBe('active');
  });

  it('load is tenant-scoped: tenant A cannot see tenant B snapshot', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B task',
      summary: 'B',
      next_step: 'B',
      session_id: 'sess-b',
      source: 'test',
    });

    expect(loadActiveTaskSnapshot(tmpDir, 'tenantA')).toBeNull();
    expect(loadActiveTaskSnapshot(tmpDir, 'tenantB')).not.toBeNull();
  });

  it('clear is tenant-scoped: clearing tenant A does not clear tenant B', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A',
      summary: 'A',
      next_step: 'A',
      session_id: 'sess-a',
      source: 'test',
    });
    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B',
      summary: 'B',
      next_step: 'B',
      session_id: 'sess-b',
      source: 'test',
    });

    const cleared = clearActiveTaskSnapshot(tmpDir, 'tenantA');
    expect(cleared).toBe(true);

    expect(loadActiveTaskSnapshot(tmpDir, 'tenantA')).toBeNull();
    const bAfter = loadActiveTaskSnapshot(tmpDir, 'tenantB');
    expect(bAfter).not.toBeNull();
    expect(bAfter!.task).toBe('B');
  });

  it('same-tenant supersede still works: saving twice retires the older row', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'first',
      summary: 'first',
      next_step: 'first',
      session_id: 'sess-a',
      source: 'test',
    });
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'second',
      summary: 'second',
      next_step: 'second',
      session_id: 'sess-a',
      source: 'test',
    });

    const snap = loadActiveTaskSnapshot(tmpDir, 'tenantA');
    expect(snap!.task).toBe('second');
  });
});
