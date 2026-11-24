import { ingestMessage } from '../../src/entry/eval-scripts.js';
import { loadAllEntries } from '../../src/entry/testing.js';
import { adminActor } from '../../src/api/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { RequestStores } from '../../src/db/request-stores.js';
import { loadConfig } from '../../src/host/config-file.js';

export interface SmokeOptions {
  hippoRoot: string;
  count: number;
  replay: number;
  session?: RequestStores;
}

export interface SmokeResult {
  uniqueMemories: number;
  totalIngestCalls: number;
  outboundHttp: number;
  durationMs: number;
}

export async function runSlackSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const ctx = {
    hippoRoot: opts.hippoRoot,
    tenantId: 'default',
    actor: adminActor('connector:slack'),
    store: sqliteStore(opts.hippoRoot, { session: opts.session }),
    config: loadConfig(opts.hippoRoot),
  };
  const start = Date.now();
  let calls = 0;

  const origFetch = globalThis.fetch;
  let outboundHttp = 0;
  globalThis.fetch = (..._args: unknown[]): Promise<Response> => {
    outboundHttp++;
    throw new Error('outbound HTTP forbidden during slack smoke');
  };

  try {
    for (let pass = 0; pass < opts.replay; pass++) {
      for (let i = 0; i < opts.count; i++) {
        await ingestMessage(ctx, {
          teamId: 'T1',
          channel: { id: 'C1', is_private: false },
          message: {
            type: 'message',
            channel: 'C1',
            user: 'U1',
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

  const uniqueMemories = loadAllEntries(opts.hippoRoot).filter(
    (e) => e.tenantId === 'default' && e.tags.includes('source:slack'),
  ).length;
  return {
    uniqueMemories,
    totalIngestCalls: calls,
    outboundHttp,
    durationMs: Date.now() - start,
  };
}

// Use pathToFileURL for cross-platform `import.meta.url` matching (Windows
// emits `file:///C:/...` which `file://${process.argv[1]}` cannot match).
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { initStore } = await import('../../src/entry/testing.js');

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
