// Pins what `hippo watch`, `audit --fix`, `sleep`, `refine`, `decide --supersedes`, `projects` and the session-end worker store, audit and
// print on a real store with no server, so moving their writes and store opens out of the CLI cannot change a row or a byte.
// What a snapshot masks is listed in tests/_helpers/cli-parity-store.ts. The first case of each verb spawns the built CLI; the rest run it in process.
import { describe, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminActor, reject } from '../../src/api/index.js';
import { refineStore, type RefineOptions } from '../../src/cli/refine-llm.js';
import { Layer } from '../../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { captureError } from '../../src/learn/autolearn.js';
import { recordTokenUse } from '../../src/store/token-ledger.js';
import type { TokenSurface } from '../../src/store/port/token-ledger.js';
import { query, Store, type ExtraState, type Row } from '../_helpers/cli-parity-store.js';
import { apiCtx } from '../_helpers/api-ctx.js';

const FAKE_NOW = '2026-02-01T00:00:00.000Z';

type Refined = Awaited<ReturnType<typeof refineStore>>;

function exec(root: string, sql: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(sql);
  } finally {
    closeHippoDb(db);
  }
}

const CLEAN = 'the billing service retries a failed charge three times';

describe('hippo watch (built CLI, no server)', () => {
  const STDERR = 'connection refused on port 5432\n';

  /** A command that fails the same way in every shell, and one that succeeds. */
  function scripts(s: Store): void {
    writeFileSync(join(s.cwd, 'fail.js'), `process.stderr.write(${JSON.stringify(STDERR)}); process.exit(3);\n`);
    writeFileSync(join(s.cwd, 'ok.js'), "process.stdout.write('done\\n');\n");
  }

  // The process pin for watch: two spawned runs of the built CLI, each running a failing child.
  it('stores a failed command, and a second failure of it beside the first', async () => {
    const s = new Store({ spawned: true });
    scripts(s);
    await s.run('watch', 'node', 'fail.js');
    await s.run('watch', 'node', 'fail.js');
    s.expectPinned();
  }, 32_000);

  it('a failure that matches a rejected value is not stored', async () => {
    const s = new Store();
    scripts(s);
    const value = captureError(3, STDERR, 'node fail.js').content;
    await reject(apiCtx(s.root, 'default', adminActor('cli')), { value, reason: 'wrong' });
    s.settle();
    await s.run('watch', 'node', 'fail.js');
    s.expectPinned();
  });

  // Spawned: the watched command writes to the stdout it inherits, which only a real process hands down.
  it('a command that succeeds stores nothing', async () => {
    const s = new Store({ spawned: true });
    scripts(s);
    await s.run('watch', 'node', 'ok.js');
    s.expectPinned();
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    scripts(s);
    await s.run('watch', 'node', 'fail.js');
    s.expectPinned();
  });

  it('no command', async () => {
    const s = new Store();
    await s.run('watch');
    s.expectPinned();
  });
});

/** One clean row and one warning; with `errors`, two rows the audit removes and a pinned one it keeps. */
function seedForAudit(s: Store, errors: boolean): void {
  s.seed(CLEAN);
  s.seed('to fix the retry loop');
  if (errors) {
    s.seed('too small');
    s.seed('Merge branch feature/billing into main');
    s.seed('pinned ok', { pinned: true });
  }
  s.settle();
}

describe('hippo audit --fix (built CLI, no server)', () => {
  it('removes each error and leaves the warnings', async () => {
    const s = new Store({ spawned: true });
    seedForAudit(s, true);
    await s.run('audit', '--fix');
    await s.run('audit', '--fix');
    s.expectPinned();
  });

  it('--dry-run removes nothing, and neither does a run without --fix', async () => {
    const s = new Store();
    seedForAudit(s, true);
    await s.run('audit');
    await s.run('audit', '--fix', '--dry-run');
    s.expectPinned();
  });

  it('no errors, only warnings', async () => {
    const s = new Store();
    seedForAudit(s, false);
    await s.run('audit', '--fix');
    s.expectPinned();
  });

  it('a store where every row passes', async () => {
    const s = new Store();
    s.seed(CLEAN);
    s.settle();
    await s.run('audit', '--fix');
    s.expectPinned();
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    await s.run('audit', '--fix');
    s.expectPinned();
  });
});

/** Rows under two project names, two the sleep audit removes, one pinned and one warning, all older than the fixed clock. */
function seedForSleep(s: Store): void {
  s.env['HIPPO_FAKE_NOW'] = FAKE_NOW;
  s.seedAged(
    'mem_sleep_app',
    '2026-01-20T00:00:00.000Z',
    'deploy rollback needs the database migration reverted before the api restarts',
    { tags: ['deploy'] },
  );
  s.seedAged(
    'mem_sleep_web',
    '2026-01-21T00:00:00.000Z',
    'the checkout page caches the cart total for sixty seconds',
    { tags: ['web'] },
    { origin_project: 'web' },
  );
  s.seedAged('mem_sleep_short', '2026-01-22T00:00:00.000Z', 'too small');
  s.seedAged('mem_sleep_noise', '2026-01-23T00:00:00.000Z', 'Merge branch feature/billing into main');
  s.seedAged('mem_sleep_pinned', '2026-01-24T00:00:00.000Z', 'pinned ok', { pinned: true });
  s.seedAged('mem_sleep_warn', '2026-01-25T00:00:00.000Z', 'to fix the retry loop');
  s.settle();
}

describe('hippo sleep (built CLI, no server)', () => {
  it('removes audit errors on a store with two project names, and a second sleep finds none', async () => {
    const s = new Store({ spawned: true });
    seedForSleep(s);
    await s.run('sleep', '--no-learn', '--no-share');
    await s.run('sleep', '--no-learn', '--no-share');
    s.expectPinned();
  });

  it('--dry-run counts the errors and removes nothing', async () => {
    const s = new Store();
    seedForSleep(s);
    await s.run('sleep', '--dry-run', '--no-learn', '--no-share');
    s.expectPinned();
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    await s.run('sleep', '--no-learn', '--no-share');
    s.expectPinned();
  });
});

describe('hippo refine (verb function, injected fetcher, no model)', () => {
  const MERGED = '[Consolidated from 2 related memories]\n\n';
  const answering =
    (text: string, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify({ content: [{ text }] }), { status });
  const refine = (s: Store, opts: Omit<RefineOptions, 'apiKey' | 'tenantId'>): Promise<Refined> =>
    refineStore(s.root, { apiKey: 'no-key', tenantId: 'default', ...opts });

  function seedForRefine(s: Store): void {
    s.seed(`${MERGED}the billing service retries a failed charge, three times in a row`, {
      layer: Layer.Semantic,
      tags: ['billing'],
    });
    s.seed(`${MERGED}the invoice worker sends a receipt after each charge`, {
      layer: Layer.Semantic,
      tags: ['llm-refined', 'billing'],
    });
    s.seed(CLEAN, { layer: Layer.Semantic });
    s.settle();
  }

  it('rewrites a merged row and tags it, skips a refined one, and rewrites both under all', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore', () => refine(s, { fetcher: answering('Failed charges are retried three times.') }));
    await s.call('refineStore all', () =>
      refine(s, { fetcher: answering('Each charge is retried, then a receipt is sent.'), all: true }),
    );
    s.expectPinned();
  });

  it('a failed model call leaves the row as it was', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore', () => refine(s, { fetcher: answering('ignored', 500) }));
    s.expectPinned();
  });

  it('dryRun writes nothing', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore dryRun', () =>
      refine(s, { fetcher: answering('Failed charges are retried three times.'), dryRun: true }),
    );
    s.expectPinned();
  });
});

describe('hippo decide --supersedes (built CLI, no server)', () => {
  const decisions = (s: Store): Row[] =>
    query(
      s.root,
      'SELECT id, memory_id, decision_text, context, status, superseded_by, superseded_at, closed_at FROM decisions ORDER BY id',
    );

  it('weakens the memory of an earlier decision, and again on a second supersede', async () => {
    const s = new Store({ spawned: true });
    await s.run('decide', 'use postgres for the ledger', '--context', 'it handles the join load');
    const oldId = s.lastId();
    await s.run('decide', 'use sqlite for the ledger', '--supersedes', oldId);
    await s.run('decide', 'use duckdb for the ledger', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  });

  it('weakens a plain memory that no decision row names', async () => {
    const s = new Store();
    const oldId = s.seed(CLEAN, { tags: ['billing'] });
    s.settle();
    await s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  });

  it('an unknown memory id, and --supersedes with no id', async () => {
    const s = new Store();
    await s.run('decide', 'use sqlite for the ledger', '--supersedes', 'mem_does_not_exist');
    await s.run('decide', 'use sqlite for the ledger', '--supersedes');
    s.expectPinned({ decisions: decisions(s) });
  });

  it('a weaken the store refuses still records the decision, with a warning', async () => {
    const s = new Store();
    const oldId = s.seed(CLEAN, { tags: ['billing'] });
    for (const event of ['INSERT', 'UPDATE']) {
      exec(
        s.root,
        `CREATE TRIGGER refuse_weaken_${event} BEFORE ${event} ON memories WHEN NEW.id = '${oldId}' AND NEW.confidence = 'stale' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
      );
    }
    s.settle();
    await s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  });
});

describe('hippo projects (built CLI, no server)', () => {
  it('lists two project names, and previews a merge and a repair', async () => {
    const s = new Store({ spawned: true });
    s.seed(CLEAN);
    s.seed('the checkout page caches the cart total for sixty seconds', {}, { origin_project: 'web' });
    s.settle();
    await s.run('projects');
    await s.run('projects', '--json');
    await s.run('projects', 'merge', 'web', 'app');
    await s.run('projects', 'repair');
    await s.run('projects', 'rename');
    s.expectPinned();
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    await s.run('projects');
    s.expectPinned();
  });
});

describe('__session-end-worker re-read count (built CLI, no server)', () => {
  const SESSION = 'sess-maint-parity';
  // Noon UTC yesterday: re-read rows are per UTC day, so a run near midnight must not split a case's calls.
  const NOON = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 12 * 3_600_000;
  const iso = (at: number): string => new Date(at).toISOString();

  /** One block sent to the session at noon, which each later model call reads again. */
  function book(root: string, surface: TokenSurface, tokens: number): void {
    const db = openHippoDb(root);
    try {
      recordTokenUse(db, {
        tenantId: 'default',
        sessionId: SESSION,
        surface,
        event: 'inject',
        items: 1,
        tokens,
        hash: 'h1',
        now: iso(NOON),
      });
    } finally {
      closeHippoDb(db);
    }
  }

  function callLine(n: number): string {
    const message = {
      id: `m${n}`,
      model: 'claude-test',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    return JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: iso(NOON + n * 10_000), message });
  }

  /** Ends a session of three model calls, and answers the ledger rows of both stores and the worker's re-read log lines. */
  async function endSession(s: Store): Promise<ExtraState> {
    const transcript = join(s.base, `${SESSION}.jsonl`);
    writeFileSync(transcript, `${[1, 2, 3].map(callLine).join('\n')}\n`);
    const log = join(s.base, 'session-end.log');
    await s.run('__session-end-worker', '--log-file', log, '--transcript', transcript, '--session-id', SESSION);
    const ledger = (root: string): Row[] =>
      query(
        root,
        "SELECT tenant_id, session_id, surface, event, items, tokens FROM token_ledger WHERE event IN ('inject', 'reread') ORDER BY id",
      );
    const rereadLog = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.includes('re-read'))
      : [];
    return { rereadLog, ledger: { local: ledger(s.root), global: ledger(s.home) } };
  }

  // The process pin for session end: two spawned runs over a project store and the global store.
  it('books the project store and the global store, and a second pass leaves the same rows', async () => {
    const s = new Store({ global: true, spawned: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    await endSession(s);
    s.expectPinned(await endSession(s));
  }, 42_000);

  it('a store that refuses the rows is logged, and the other store is still counted', async () => {
    const s = new Store({ global: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    exec(
      s.root,
      "CREATE TRIGGER refuse_reread BEFORE INSERT ON token_ledger WHEN NEW.event = 'reread' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    s.expectPinned(await endSession(s));
  });

  it('a folder with no store, here or globally', async () => {
    const s = new Store({ init: false });
    s.expectPinned(await endSession(s));
  });
});
