import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore, loadAllEntries } from '../src/store.js';
import { runSlackSmoke } from '../benchmarks/e1.3/slack-1000-event-smoke.js';

describe('slack 1000-event smoke (CI subset)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-smoke-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('100 events, replayed twice, produces exactly 100 raw memories with zero outbound HTTP', async () => {
    const result = await runSlackSmoke({ hippoRoot: root, count: 100, replay: 2 });
    expect(result.uniqueMemories).toBe(100);
    expect(result.outboundHttp).toBe(0);
    expect(result.totalIngestCalls).toBe(200);

    const all = loadAllEntries(root).filter((e) => e.tags.includes('source:slack'));
    expect(all).toHaveLength(100);
    expect(all.every((e) => e.kind === 'raw')).toBe(true);
    expect(all.every((e) => e.tags.includes('source:slack'))).toBe(true);
  });
});
