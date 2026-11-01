/**
 * The Slack workspace map on a real store; each test opens its own, so no state crosses tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mapSlackWorkspace, slackWorkspaceMap, unmapSlackWorkspace } from '../../src/api/hippo-db/connector-events.js';
import { ForbiddenError } from '../../src/base/errors/api-errors.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeStore } from '../_helpers/make-root.js';

describe('the Slack workspace map', () => {
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('slack-ws'));
  });

  it('mapSlackWorkspace inserts a new row and returns the envelope', async () => {
    const ws = await mapSlackWorkspace(apiCtx(hippoRoot), 'T01', 'acme');
    expect(ws.teamId).toBe('T01');
    expect(ws.tenantId).toBe('acme');
    expect(ws.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mapSlackWorkspace upserts on team_id conflict (operator moves workspace)', async () => {
    await mapSlackWorkspace(apiCtx(hippoRoot), 'T01', 'acme');
    await mapSlackWorkspace(apiCtx(hippoRoot), 'T01', 'globex');
    const items = await slackWorkspaceMap(apiCtx(hippoRoot));
    expect(items).toHaveLength(1);
    expect(items[0]!.teamId).toBe('T01');
    expect(items[0]!.tenantId).toBe('globex');
  });

  it('slackWorkspaceMap returns empty array on empty table', async () => {
    expect(await slackWorkspaceMap(apiCtx(hippoRoot))).toEqual([]);
  });

  it('slackWorkspaceMap sorts by team_id for stable output', async () => {
    await mapSlackWorkspace(apiCtx(hippoRoot), 'TZZ', 't1');
    await mapSlackWorkspace(apiCtx(hippoRoot), 'TAA', 't2');
    await mapSlackWorkspace(apiCtx(hippoRoot), 'TMM', 't3');
    const items = await slackWorkspaceMap(apiCtx(hippoRoot));
    expect(items.map((w) => w.teamId)).toEqual(['TAA', 'TMM', 'TZZ']);
  });

  it('unmapSlackWorkspace returns true when a row was deleted', async () => {
    await mapSlackWorkspace(apiCtx(hippoRoot), 'T01', 'acme');
    expect(await unmapSlackWorkspace(apiCtx(hippoRoot), 'T01')).toBe(true);
    expect(await slackWorkspaceMap(apiCtx(hippoRoot))).toEqual([]);
  });

  it('unmapSlackWorkspace returns false when no row matched', async () => {
    expect(await unmapSlackWorkspace(apiCtx(hippoRoot), 'T_UNKNOWN')).toBe(false);
  });

  it('mapSlackWorkspace generates monotonically-increasing addedAt timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = await mapSlackWorkspace(apiCtx(hippoRoot), 'T01', 'a');
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const second = await mapSlackWorkspace(apiCtx(hippoRoot), 'T02', 'b');
      expect(second.addedAt > first.addedAt).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a caller who is not the host operator, since a row routes past its tenant', async () => {
    const member = apiCtx(hippoRoot, 'acme', { subject: 'k1', role: 'admin' });
    await expect(mapSlackWorkspace(member, 'T01', 'acme')).rejects.toThrow(ForbiddenError);
    await expect(slackWorkspaceMap(member)).rejects.toThrow(ForbiddenError);
    await expect(unmapSlackWorkspace(member, 'T01')).rejects.toThrow(ForbiddenError);
  });
});
