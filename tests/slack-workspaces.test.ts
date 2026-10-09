/**
 * Unit tests for slack workspace registration helpers (T2B 2026-05-24).
 *
 * Real-DB tests per project rule. Each test opens its own SQLite store
 * to avoid cross-test state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import {
  addWorkspace,
  listWorkspaces,
  removeWorkspace,
} from '../src/connectors/slack/workspaces.js';

describe('slack workspaces helper', () => {
  let root: string;
  let hippoRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-ws-'));
    hippoRoot = join(root, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('addWorkspace inserts a new row and returns the envelope', () => {
    const ws = addWorkspace(hippoRoot, { teamId: 'T01', tenantId: 'acme' });
    expect(ws.teamId).toBe('T01');
    expect(ws.tenantId).toBe('acme');
    expect(ws.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('addWorkspace upserts on team_id conflict (operator moves workspace)', () => {
    addWorkspace(hippoRoot, { teamId: 'T01', tenantId: 'acme' });
    addWorkspace(hippoRoot, { teamId: 'T01', tenantId: 'globex' });
    const items = listWorkspaces(hippoRoot);
    expect(items).toHaveLength(1);
    expect(items[0]!.teamId).toBe('T01');
    expect(items[0]!.tenantId).toBe('globex');
  });

  it('listWorkspaces returns empty array on empty table', () => {
    expect(listWorkspaces(hippoRoot)).toEqual([]);
  });

  it('listWorkspaces sorts by team_id for stable output', () => {
    addWorkspace(hippoRoot, { teamId: 'TZZ', tenantId: 't1' });
    addWorkspace(hippoRoot, { teamId: 'TAA', tenantId: 't2' });
    addWorkspace(hippoRoot, { teamId: 'TMM', tenantId: 't3' });
    const items = listWorkspaces(hippoRoot);
    expect(items.map((w) => w.teamId)).toEqual(['TAA', 'TMM', 'TZZ']);
  });

  it('removeWorkspace returns true when a row was deleted', () => {
    addWorkspace(hippoRoot, { teamId: 'T01', tenantId: 'acme' });
    expect(removeWorkspace(hippoRoot, 'T01')).toBe(true);
    expect(listWorkspaces(hippoRoot)).toEqual([]);
  });

  it('removeWorkspace returns false when no row matched', () => {
    expect(removeWorkspace(hippoRoot, 'T_UNKNOWN')).toBe(false);
  });

  it('addWorkspace generates monotonically-increasing addedAt timestamps', async () => {
    const first = addWorkspace(hippoRoot, { teamId: 'T01', tenantId: 'a' });
    // Real new Date() across two add calls in the same ms can collide.
    // 2ms sleep guarantees distinct ISO timestamps.
    await new Promise((r) => setTimeout(r, 2));
    const second = addWorkspace(hippoRoot, { teamId: 'T02', tenantId: 'b' });
    expect(second.addedAt >= first.addedAt).toBe(true);
  });
});
