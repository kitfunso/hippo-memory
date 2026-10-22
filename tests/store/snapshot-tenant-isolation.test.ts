import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeRoot } from '../_helpers/make-root.js';
import { loadActiveTaskSnapshot, clearActiveTaskSnapshot, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let tmpDir: string;
beforeEach(() => {
  tmpDir = makeRoot('snapshot-tenant', { init: false });
});

describe('task_snapshot tenant isolation', () => {
  it('tenant B saving a snapshot does not supersede tenant A active row', () => {
    initTestStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A task',
      summary: 'A summary',
      nextStep: 'A next',
      sessionId: 'sess-a',
      source: 'test',
    });

    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B task',
      summary: 'B summary',
      nextStep: 'B next',
      sessionId: 'sess-b',
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
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B task',
      summary: 'B',
      nextStep: 'B',
      sessionId: 'sess-b',
      source: 'test',
    });

    expect(loadActiveTaskSnapshot(tmpDir, 'tenantA')).toBeNull();
    expect(loadActiveTaskSnapshot(tmpDir, 'tenantB')).not.toBeNull();
  });

  it('clear is tenant-scoped: clearing tenant A does not clear tenant B', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A',
      summary: 'A',
      nextStep: 'A',
      sessionId: 'sess-a',
      source: 'test',
    });
    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B',
      summary: 'B',
      nextStep: 'B',
      sessionId: 'sess-b',
      source: 'test',
    });

    const cleared = await clearActiveTaskSnapshot(tmpDir, 'tenantA');
    expect(cleared).toBe(true);

    expect(loadActiveTaskSnapshot(tmpDir, 'tenantA')).toBeNull();
    const bAfter = loadActiveTaskSnapshot(tmpDir, 'tenantB');
    expect(bAfter).not.toBeNull();
    expect(bAfter!.task).toBe('B');
  });

  it('mirror files are tenant-scoped: tenant B does not overwrite tenant A active-task.md', () => {
    initTestStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A keeps its mirror',
      summary: 'A',
      nextStep: 'A',
      sessionId: 'sess-a',
      source: 'test',
    });
    saveActiveTaskSnapshot(tmpDir, 'tenantB', {
      task: 'B has its own',
      summary: 'B',
      nextStep: 'B',
      sessionId: 'sess-b',
      source: 'test',
    });

    const aMirror = path.join(tmpDir, 'buffer', 'active-task.tenantA.md');
    const bMirror = path.join(tmpDir, 'buffer', 'active-task.tenantB.md');
    const defaultMirror = path.join(tmpDir, 'buffer', 'active-task.md');

    expect(fs.existsSync(aMirror)).toBe(true);
    expect(fs.existsSync(bMirror)).toBe(true);
    expect(fs.existsSync(defaultMirror)).toBe(false);
    expect(fs.readFileSync(aMirror, 'utf8')).toContain('A keeps its mirror');
    expect(fs.readFileSync(bMirror, 'utf8')).toContain('B has its own');
  });

  it('default tenant keeps the unsuffixed mirror filename for back-compat', () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'd',
      summary: 'd',
      nextStep: 'd',
      sessionId: 'sess-d',
      source: 'test',
    });
    expect(fs.existsSync(path.join(tmpDir, 'buffer', 'active-task.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'buffer', 'active-task.default.md'))).toBe(false);
  });

  it('same-tenant supersede still works: saving twice retires the older row', () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'first',
      summary: 'first',
      nextStep: 'first',
      sessionId: 'sess-a',
      source: 'test',
    });
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'second',
      summary: 'second',
      nextStep: 'second',
      sessionId: 'sess-a',
      source: 'test',
    });

    const snap = loadActiveTaskSnapshot(tmpDir, 'tenantA');
    expect(snap!.task).toBe('second');
  });
});
