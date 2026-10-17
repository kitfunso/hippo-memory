/**
 * Unit tests for slack workspace registration helpers (T2B 2026-05-24).
 *
 * Real-DB tests per project rule. Each test opens its own SQLite store
 * to avoid cross-test state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqliteStore } from '../src/store/sqlite/store.js';
import {
  addWorkspace,
  listWorkspaces,
  removeWorkspace,
} from '../src/connectors/slack/workspaces.js';
import { makeStore } from './_helpers/make-root.js';

describe('slack workspaces helper', () => {
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('slack-ws'));
  });

  it('addWorkspace inserts a new row and returns the envelope', async () => {
    const ws = await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T01', tenantId: 'acme' });
    expect(ws.teamId).toBe('T01');
    expect(ws.tenantId).toBe('acme');
    expect(ws.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('addWorkspace upserts on team_id conflict (operator moves workspace)', async () => {
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T01', tenantId: 'acme' });
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T01', tenantId: 'globex' });
    const items = (await listWorkspaces(sqliteStore(hippoRoot)));
    expect(items).toHaveLength(1);
    expect(items[0]!.teamId).toBe('T01');
    expect(items[0]!.tenantId).toBe('globex');
  });

  it('listWorkspaces returns empty array on empty table', async () => {
    expect((await listWorkspaces(sqliteStore(hippoRoot)))).toEqual([]);
  });

  it('listWorkspaces sorts by team_id for stable output', async () => {
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'TZZ', tenantId: 't1' });
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'TAA', tenantId: 't2' });
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'TMM', tenantId: 't3' });
    const items = (await listWorkspaces(sqliteStore(hippoRoot)));
    expect(items.map((w) => w.teamId)).toEqual(['TAA', 'TMM', 'TZZ']);
  });

  it('removeWorkspace returns true when a row was deleted', async () => {
    await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T01', tenantId: 'acme' });
    expect(await removeWorkspace(sqliteStore(hippoRoot), 'T01')).toBe(true);
    expect((await listWorkspaces(sqliteStore(hippoRoot)))).toEqual([]);
  });

  it('removeWorkspace returns false when no row matched', async () => {
    expect(await removeWorkspace(sqliteStore(hippoRoot), 'T_UNKNOWN')).toBe(false);
  });

  it('addWorkspace generates monotonically-increasing addedAt timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T01', tenantId: 'a' });
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const second = await addWorkspace(sqliteStore(hippoRoot), { teamId: 'T02', tenantId: 'b' });
      expect(second.addedAt > first.addedAt).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
