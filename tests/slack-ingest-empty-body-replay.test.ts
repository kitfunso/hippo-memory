/**
 * Regression: ingestMessage status string consistency on empty-body replay
 * (B3 v1.12.6).
 *
 * Pre-v1.12.6: empty-body event first call returned 'skipped' (memory_id=null,
 * markEventSeen called), but the replay returned 'duplicate' — same effect,
 * different status string. A switch/case in a downstream caller would treat
 * them as two distinct branches.
 *
 * Fix: replay of an empty-body event (cached memory_id IS NULL) now returns
 * 'skipped' too. memory_id non-NULL still returns 'duplicate' (an actual
 * memory was written previously).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { adminActor } from '../src/api.js';
import type { ChannelMeta } from '../src/connectors/slack/scope.js';

function ctx(hippoRoot: string) {
  return {
    hippoRoot,
    tenantId: 'default',
    actor: adminActor('test:slack-ingest-empty-body'),
  };
}

const channel: ChannelMeta = { id: 'C01', is_private: false };

describe('ingestMessage empty-body replay status consistency (B3 v1.12.6)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-ingest-empty-'));
    initStore(join(root, '.hippo'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('first ingest of empty body returns skipped + memory_id=null', () => {
    const hippoRoot = join(root, '.hippo');
    const result = ingestMessage(ctx(hippoRoot), {
      teamId: 'T01',
      channel,
      // Use a message shape that messageToRememberOpts rejects (empty text + no thread_ts).
      message: { type: 'message', user: 'U01', ts: '1716553200.000100', text: '' },
      eventId: 'Ev_empty_001',
    });
    expect(result.status).toBe('skipped');
    expect(result.memoryId).toBeNull();
  });

  it('replay of empty body returns skipped (not duplicate) — B3 fix', () => {
    const hippoRoot = join(root, '.hippo');
    const opts = {
      teamId: 'T01',
      channel,
      message: { type: 'message' as const, user: 'U01', ts: '1716553200.000200', text: '' },
      eventId: 'Ev_empty_002',
    };
    const first = ingestMessage(ctx(hippoRoot), opts);
    expect(first.status).toBe('skipped');
    expect(first.memoryId).toBeNull();

    const replay = ingestMessage(ctx(hippoRoot), opts);
    // Pre-fix: 'duplicate' (the asymmetry). Post-fix: 'skipped' (consistent).
    expect(replay.status).toBe('skipped');
    expect(replay.memoryId).toBeNull();
  });

  it('replay of real-content event still returns duplicate (memory_id non-null)', () => {
    const hippoRoot = join(root, '.hippo');
    const opts = {
      teamId: 'T01',
      channel,
      message: {
        type: 'message' as const,
        user: 'U02',
        ts: '1716553200.000300',
        text: 'a real message that gets ingested',
      },
      eventId: 'Ev_real_001',
    };
    const first = ingestMessage(ctx(hippoRoot), opts);
    expect(first.status).toBe('ingested');
    expect(first.memoryId).not.toBeNull();

    const replay = ingestMessage(ctx(hippoRoot), opts);
    // Non-null cached memory_id → 'duplicate' (correct, not affected by B3 fix).
    expect(replay.status).toBe('duplicate');
    expect(replay.memoryId).toBe(first.memoryId);
  });
});
