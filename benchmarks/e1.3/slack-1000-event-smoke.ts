/**
 * E1.3 1000-event Slack smoke benchmark.
 *
 * ROADMAP success criterion: ingest 1000 synthetic Slack events, replay each
 * one twice, and prove (a) exactly `count` unique memories are written
 * (idempotency holds), (b) zero outbound HTTP calls escape the connector
 * layer, (c) per-call latency stays under 500ms.
 *
 * The no-outbound-HTTP invariant is proven (review patch #5) by replacing
 * `globalThis.fetch` with a function that THROWS on any call. If a future
 * code path inside the connector ever reaches for fetch (e.g. a user
 * resolution shortcut), this smoke fails loud rather than silently lying
 * with a hardcoded 0. The original fetch is restored in `finally` so the
 * spy never poisons later tests.
 */

import { ingestMessage } from '../../src/connectors/slack/ingest.js';
import { loadAllEntries } from '../../src/store.js';

export interface SmokeOpts {
  hippoRoot: string;
  count: number;
  replay: number;
}

export interface SmokeResult {
  uniqueMemories: number;
  totalIngestCalls: number;
  outboundHttp: number;
  durationMs: number;
}

export async function runSlackSmoke(opts: SmokeOpts): Promise<SmokeResult> {
  const ctx = {
    hippoRoot: opts.hippoRoot,
    tenantId: 'default',
    actor: 'connector:slack',
  };
  const start = Date.now();
  let calls = 0;

  // Review patch #5: spy globalThis.fetch with a throwing function. The smoke
  // fails LOUD if anything in the ingest path ever calls fetch().
  const origFetch = globalThis.fetch;
  let outboundHttp = 0;
  globalThis.fetch = ((..._args: unknown[]): Promise<Response> => {
    outboundHttp++;
    throw new Error('outbound HTTP forbidden during slack smoke');
  }) as typeof fetch;

  try {
    for (let pass = 0; pass < opts.replay; pass++) {
      for (let i = 0; i < opts.count; i++) {
        ingestMessage(ctx, {
          teamId: 'T1',
          channel: { id: 'C1', is_private: false },
          message: {
            type: 'message',
            channel: 'C1',
            user: 'U1',
            // Use a content body well over the 3-char minimum enforced by
            // memory.ts so synthetic events survive validation.
            text: `slack synthetic event ${i}`,
            ts: `${1700000000 + i}.000100`,
          },
          eventId: `Ev-${i}`,
        });
        calls++;
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  const uniqueMemories = loadAllEntries(opts.hippoRoot).filter((e) =>
    e.tags.includes('source:slack'),
  ).length;
  return {
    uniqueMemories,
    totalIngestCalls: calls,
    outboundHttp,
    durationMs: Date.now() - start,
  };
}

// Standalone CLI: 1000 events, replay=2, fail loud on regression.
// Use pathToFileURL for cross-platform `import.meta.url` matching (Windows
// emits `file:///C:/...` which `file://${process.argv[1]}` cannot match).
const { pathToFileURL } = await import('url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mkdtempSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { initStore } = await import('../../src/store.js');

  const root = mkdtempSync(join(tmpdir(), 'hippo-slack-smoke-cli-'));
  try {
    initStore(root);
    const r = await runSlackSmoke({ hippoRoot: root, count: 1000, replay: 2 });
    console.log(JSON.stringify(r, null, 2));
    if (r.uniqueMemories !== 1000) {
      console.error('FAIL: uniqueMemories !== 1000');
      process.exit(1);
    }
    if (r.outboundHttp !== 0) {
      console.error('FAIL: outboundHttp !== 0');
      process.exit(1);
    }
    if (r.totalIngestCalls !== 2000) {
      console.error('FAIL: totalIngestCalls !== 2000');
      process.exit(1);
    }
    if (r.durationMs / r.totalIngestCalls > 500) {
      console.error('FAIL: per-call latency >500ms');
      process.exit(1);
    }
    console.log('PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
