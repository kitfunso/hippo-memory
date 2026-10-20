// The api functions the CLI and MCP commands call instead of src/domain: tenant scope and the host-admin gate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminActor,
  ForbiddenError,
  liftRejection,
  listRejections,
  rejectOnHost,
  remember,
  sharePeers,
} from '../../src/api/index.js';
import { graphViewOnHost } from '../../src/api/objects/graph.js';
import { traceRecord } from '../../src/api/memories/trace.js';
import { Layer } from '../../src/base/memory/memory.js';
import type { Actor } from '../../src/api/types.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readEntry } from '../_helpers/root-forms.js';

const MEMBER: Actor = { subject: 'member', role: 'admin', hostAdmin: false };
let root: string;
const ctx = (tenantId = 'default', actor = adminActor('cli')): FullContext => apiCtx(root, tenantId, actor);

beforeEach(() => {
  root = makeRoot('api-surface-doors', { config: { embeddings: { enabled: false } } });
  vi.stubEnv('HIPPO_HOME', join(root, '.hippo-global'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function rejectOne(tenantId: string, content: string): Promise<string> {
  const id = (await remember(ctx(tenantId), { content })).id;
  const result = await rejectOnHost(ctx(tenantId), { memoryId: id, reason: 'wrong' });
  return result.digest;
}

describe('rejections through the api', () => {
  it('lists only the caller tenant tombstones and lifts one by prefix as the caller', async () => {
    const digest = await rejectOne('default', 'the release train leaves on fridays');
    await rejectOne('other', 'the other tenant keeps its own tombstone');
    expect((await listRejections(ctx())).map((r) => r.digest)).toEqual([digest]);
    expect(await liftRejection(ctx('other'), digest.slice(0, 12))).toEqual({ status: 'not_found' });
    expect(await liftRejection(ctx(), digest.slice(0, 12))).toMatchObject({ status: 'ok', digest });
    expect(await listRejections(ctx())).toEqual([]);
  });
});

describe('host-admin reads', () => {
  it('refuses every tenant peer list and the unscoped graph view to a member', async () => {
    await expect(sharePeers(ctx('default', MEMBER), { allTenants: true })).rejects.toThrow(ForbiddenError);
    await expect(graphViewOnHost(ctx('default', MEMBER), { limit: 10 })).rejects.toThrow(ForbiddenError);
    expect(await sharePeers(ctx('default', MEMBER))).toEqual([]);
  });
});

describe('traceRecord', () => {
  it('stores the trace layer row with its outcome and session', async () => {
    const { id } = await traceRecord(ctx(), {
      task: 'ship the build',
      steps: [{ action: 'run tests', observation: 'green' }],
      outcome: 'success',
      sessionId: 'sess-1',
      tags: ['ci'],
      source: 'cli',
    });
    const row = readEntry(root, id, 'default');
    expect(row).toMatchObject({ layer: Layer.Trace, traceOutcome: 'success', sourceSessionId: 'sess-1' });
    expect(row?.content).toContain('ship the build');
  });
});
