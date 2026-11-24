import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { ingestMessage } from '../../src/surface/connectors/slack/ingest.js';
import { adminActor } from '../../src/api/index.js';
import type { ChannelMeta } from '../../src/surface/connectors/slack/scope.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeStore } from '../_helpers/make-root.js';

function ctx(hippoRoot: string) {
  return apiCtx(hippoRoot, 'default', adminActor('test:slack-ingest-empty-body'));
}

const channel: ChannelMeta = { id: 'C01', is_private: false };

describe('ingestMessage empty-body replay status consistency', () => {
  let root: string;

  beforeEach(() => {
    root = makeStore('ingest-empty').base;
  });

  it('replay of empty body returns skipped (not duplicate)', async () => {
    const hippoRoot = join(root, '.hippo');
    const opts = {
      teamId: 'T01',
      channel,
      message: { type: 'message' as const, channel: channel.id, user: 'U01', ts: '1716553200.000200', text: '' },
      eventId: 'Ev_empty_002',
    };
    const first = await ingestMessage(ctx(hippoRoot), opts);
    expect(first.status).toBe('skipped');
    expect(first.memoryId).toBeNull();

    const replay = await ingestMessage(ctx(hippoRoot), opts);
    expect(replay.status).toBe('skipped');
    expect(replay.memoryId).toBeNull();
  });

  it('replay of real-content event still returns duplicate (memory_id non-null)', async () => {
    const hippoRoot = join(root, '.hippo');
    const opts = {
      teamId: 'T01',
      channel,
      message: {
        type: 'message' as const,
        channel: channel.id,
        user: 'U02',
        ts: '1716553200.000300',
        text: 'a real message that gets ingested',
      },
      eventId: 'Ev_real_001',
    };
    const first = await ingestMessage(ctx(hippoRoot), opts);
    expect(first.status).toBe('ingested');
    expect(first.memoryId).not.toBeNull();

    const replay = await ingestMessage(ctx(hippoRoot), opts);
    expect(replay.status).toBe('duplicate');
    expect(replay.memoryId).toBe(first.memoryId);
  });
});
