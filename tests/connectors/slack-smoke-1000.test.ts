import { describe, it, expect, beforeEach } from 'vitest';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { runSlackSmoke } from '../../benchmarks/e1.3/slack-1000-event-smoke.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('slack 1000-event smoke (CI subset)', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('slack-smoke');
  });

  it('100 events, replayed twice, produces exactly 100 raw memories with zero outbound HTTP', async () => {
    // One connection for the run: a close per call checkpoints the WAL, which is slow on Windows; the benchmark CLI keeps per-call opens.
    const result = await withSharedStoreHandles(() => runSlackSmoke({ hippoRoot: root, count: 100, replay: 2 }));
    expect(result.uniqueMemories).toBe(100);
    expect(result.outboundHttp).toBe(0);
    expect(result.totalIngestCalls).toBe(200);

    const all = loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:slack'));
    expect(all).toHaveLength(100);
    expect(all.every((e) => e.kind === 'raw')).toBe(true);
    expect(all.every((e) => e.tags.includes('source:slack'))).toBe(true);
  });
});
