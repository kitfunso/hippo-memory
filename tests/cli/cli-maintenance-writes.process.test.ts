// What `hippo watch`, `audit --fix`, `sleep`, `refine`, `decide --supersedes`, `projects` and the session-end worker
// store, audit and print on a real store with no server. The first case of each verb spawns the built CLI.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminActor, reject } from '../../src/api/index.js';
import { refineStore, type RefineOptions } from '../../src/surface/cli/refine-llm.js';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { Layer } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { captureError } from '../../src/domain/learn/autolearn.js';
import { recordTokenUse } from '../../src/store/sqlite/token-ledger.js';
import type { TokenSurface } from '../../src/store/port/token-ledger.js';
import { PATH_TAGS, query, Store, type Ran } from '../_helpers/cli-verb-store.js';
import { apiCtx } from '../_helpers/api-ctx.js';

const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const NO_STORE =
  'No hippo store at <tmp>/acme/billing/ledger/app/.hippo (searched <tmp>/acme/billing/ledger/app and its parents up ' +
  'to your home directory). Run `hippo init` first.\n';

function exec(root: string, sql: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(sql);
  } finally {
    closeHippoDb(db);
  }
}

const contents = (s: Store): unknown[] => s.rows().map((r) => r['content']);

const CLEAN = 'the billing service retries a failed charge three times';

describe('hippo watch (built CLI, no server)', () => {
  const STDERR = 'connection refused on port 5432\n';
  const LEARNED = `${STDERR}\nHippo learned from failure: "connection refused on port 5432"\n`;

  /** A command that fails the same way in every shell, and one that succeeds. */
  function scripts(s: Store): void {
    writeFileSync(join(s.cwd, 'fail.js'), `process.stderr.write(${JSON.stringify(STDERR)}); process.exit(3);\n`);
    writeFileSync(join(s.cwd, 'ok.js'), "process.stdout.write('done\\n');\n");
  }

  // The process pin for watch: two spawned runs of the built CLI, each running a failing child.
  it('stores a failed command, and a second failure of it beside the first', async () => {
    const s = new Store({ spawned: true });
    scripts(s);
    const runs = [await s.run('watch', 'node', 'fail.js'), await s.run('watch', 'node', 'fail.js')];
    for (const r of runs) expect(r).toEqual({ status: 3, stdout: '', stderr: LEARNED });
    const rows = s.rows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        content: "Command 'node fail.js' failed (exit 3): connection refused on port 5432",
        layer: 'episodic',
        source: 'autolearn',
        tags: ['error', 'autolearn', 'node'],
        confidence: 'observed',
        emotional_valence: 'negative',
        half_life_days: 730,
        kind: 'distilled',
        origin_project: 'app',
      });
    }
    expect(s.audit()).toEqual(rows.map((r) => `default cli remember ${String(r['id'])}`));
    expect(s.counters()).toEqual({ total_forgotten: '0', total_remembered: '2' });
  }, 32_000);

  it('a failure that matches a rejected value is not stored', async () => {
    const s = new Store();
    scripts(s);
    const value = captureError(3, STDERR, 'node fail.js').content;
    await reject(apiCtx(s.root, 'default', adminActor('cli')), { value, reason: 'wrong' });
    s.settle();
    expect(await s.run('watch', 'node', 'fail.js')).toEqual({
      status: 3,
      stdout: '',
      stderr: `${STDERR}\nHippo: this failure matches a rejected value (wrong); not stored.\n`,
    });
    expect(s.rows()).toEqual([]);
    expect(s.audit()).toEqual([expect.stringMatching(/^default cli reject_refusal \S+$/)]);
    expect(s.auditMeta()[0]).toMatchObject({ reason: 'wrong' });
    expect(s.counters()['total_remembered']).toBe('0');
  });

  // Spawned: the watched command writes to the stdout it inherits, which only a real process hands down.
  it('a command that succeeds stores nothing', async () => {
    const s = new Store({ spawned: true });
    scripts(s);
    expect(await s.run('watch', 'node', 'ok.js')).toEqual({ status: 0, stdout: 'done\n', stderr: '' });
    expect([s.rows(), s.audit(), s.counters()['total_remembered']]).toEqual([[], [], '0']);
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    scripts(s);
    expect(await s.run('watch', 'node', 'fail.js')).toEqual({
      status: 3,
      stdout: '',
      stderr: `${STDERR}Command failed but .hippo not initialized. Run \`hippo init\` to enable auto-learn.\n`,
    });
    expect(s.storeMade()).toBe(false);
  });

  it('no command', async () => {
    const s = new Store();
    expect(await s.run('watch')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Usage: hippo watch -- <command> [args...]\n',
    });
    expect(s.rows()).toEqual([]);
  });
});

/** The ids of the rows the audit reports on; an id is empty when its row was not seeded. */
interface AuditIds {
  warn: string;
  short: string;
  noise: string;
  pinned: string;
}

/** One clean row and one warning; with `errors`, two rows the audit removes and a pinned one it keeps. */
function seedForAudit(s: Store, errors: boolean): AuditIds {
  s.seed(CLEAN);
  const warn = s.seed('to fix the retry loop');
  const ids = { warn, short: '', noise: '', pinned: '' };
  if (errors) {
    ids.short = s.seed('too small');
    ids.noise = s.seed('Merge branch feature/billing into main');
    ids.pinned = s.seed('pinned ok', { pinned: true });
  }
  s.settle();
  return ids;
}

describe('hippo audit --fix (built CLI, no server)', () => {
  /** The issue lines the audit prints for the five seeded rows. */
  const issues = (ids: AuditIds): string[] => [
    `[WARN] ${ids.warn}: sentence fragment`,
    `[ERR] ${ids.short}: too short (< 10 chars)\n         "too small"`,
    `[ERR] ${ids.noise}: release/commit noise, not a useful memory`,
    `[WARN] ${ids.pinned}: too short (< 10 chars) (pinned, kept)`,
  ];

  it('removes each error and leaves the warnings', async () => {
    const s = new Store({ spawned: true });
    const ids = seedForAudit(s, true);
    const first = await s.run('audit', '--fix');
    const second = await s.run('audit', '--fix');
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/^Audited 5 memories: 1 clean, 4 issues\n/);
    for (const line of issues(ids)) expect(first.stdout).toContain(line);
    expect(first.stdout).toMatch(/Removed 2 error-severity memories\.\n2 warnings remain \(review manually\)\.\n$/);
    expect(second.stdout).toMatch(/^Audited 3 memories: 1 clean, 2 issues\n/);
    expect(second.stdout).not.toContain('[ERR]');
    expect(second.stdout).toMatch(/No error-severity issues\. Warnings require manual review\.\n$/);
    expect(contents(s)).toEqual([CLEAN, 'to fix the retry loop', 'pinned ok']);
    expect(s.audit()).toEqual([`default cli forget ${ids.short}`, `default cli forget ${ids.noise}`]);
    expect(s.auditMeta()).toEqual([
      { reason: 'audit --fix: too short (< 10 chars)' },
      { reason: 'audit --fix: release/commit noise, not a useful memory' },
    ]);
    expect(s.counters()).toEqual({ total_forgotten: '0', total_remembered: '0' });
  });

  it('--dry-run removes nothing, and neither does a run without --fix', async () => {
    const s = new Store();
    const ids = seedForAudit(s, true);
    const plain = await s.run('audit');
    const dry = await s.run('audit', '--fix', '--dry-run');
    for (const r of [plain, dry]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^Audited 5 memories: 1 clean, 4 issues\n/);
      for (const line of issues(ids)) expect(r.stdout).toContain(line);
    }
    expect(plain.stdout).toMatch(/\n\nRun with --fix to auto-remove error-severity issues\.\n$/);
    expect(dry.stdout).toMatch(
      /\n\nWould remove 2 error-severity memories \(dry run, nothing deleted\)\.\n2 warnings would remain \(review manually\)\.\n$/,
    );
    expect(s.rows()).toHaveLength(5);
    expect(s.audit()).toEqual([]);
  });

  it('no errors, only warnings', async () => {
    const s = new Store();
    const { warn } = seedForAudit(s, false);
    const r = await s.run('audit', '--fix');
    expect(r.stdout).toMatch(/^Audited 2 memories: 1 clean, 1 issues\n/);
    expect(r.stdout).toContain(`[WARN] ${warn}: sentence fragment`);
    expect(r.stdout).toMatch(/\n\nNo error-severity issues\. Warnings require manual review\.\n$/);
    expect([s.rows().length, s.audit()]).toEqual([2, []]);
  });

  it('a store where every row passes', async () => {
    const s = new Store();
    s.seed(CLEAN);
    s.settle();
    expect(await s.run('audit', '--fix')).toEqual({
      status: 0,
      stdout: 'All 1 memories passed quality checks.\n',
      stderr: '',
    });
    expect(s.audit()).toEqual([]);
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    expect(await s.run('audit', '--fix')).toEqual({ status: 1, stdout: '', stderr: NO_STORE });
    expect(s.storeMade()).toBe(false);
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
    { originProject: 'web' },
  );
  s.seedAged('mem_sleep_short', '2026-01-22T00:00:00.000Z', 'too small');
  s.seedAged('mem_sleep_noise', '2026-01-23T00:00:00.000Z', 'Merge branch feature/billing into main');
  s.seedAged('mem_sleep_pinned', '2026-01-24T00:00:00.000Z', 'pinned ok', { pinned: true });
  s.seedAged('mem_sleep_warn', '2026-01-25T00:00:00.000Z', 'to fix the retry loop');
  s.settle();
}

describe('hippo sleep (built CLI, no server)', () => {
  const SLEPT = { consolidationCount: 0, dedupCount: 0, noShare: true, partial: false, triggeredByTenant: 'default' };

  it('removes audit errors on a store with two project names, and a second sleep finds none', async () => {
    const s = new Store({ spawned: true });
    seedForSleep(s);
    const first = await s.run('sleep', '--no-learn', '--no-share');
    const second = await s.run('sleep', '--no-learn', '--no-share');
    expect([first.status, second.status]).toEqual([0, 0]);
    expect(first.stdout).toContain('Active memories:  6\n');
    expect(first.stdout).toContain('\nAudit: removed 2 junk memories (too short/empty).\n');
    expect(first.stdout).toContain('\nMemory state: 4 memories,');
    expect(second.stdout).toContain('Active memories:  4\n');
    expect(second.stdout).not.toContain('junk memories');
    expect(s.rows().map((r) => [r['id'], r['origin_project']])).toEqual([
      ['mem_sleep_app', 'app'],
      ['mem_sleep_web', 'web'],
      ['mem_sleep_pinned', 'app'],
      ['mem_sleep_warn', 'app'],
    ]);
    expect(s.audit()).toEqual([
      'default cli forget mem_sleep_short',
      'default cli forget mem_sleep_noise',
      '__host__ cli consolidate',
      '__host__ cli consolidate',
    ]);
    expect(s.auditMeta()).toEqual([
      { reason: 'sleep-audit: too short (< 10 chars)' },
      { reason: 'sleep-audit: release/commit noise, not a useful memory' },
      { ...SLEPT, auditDeletedCount: 2, ambientTotal: 4, dryRun: false },
      { ...SLEPT, auditDeletedCount: 0, ambientTotal: 4, dryRun: false },
    ]);
    expect(s.counters()).toMatchObject({ project_repair_auto: '1', quality_repair_auto: '1' });
  });

  it('--dry-run counts the errors and removes nothing', async () => {
    const s = new Store();
    seedForSleep(s);
    const r = await s.run('sleep', '--dry-run', '--no-learn', '--no-share');
    expect(r.stdout).toMatch(/^Running consolidation \(dry run\)\.\.\.\n/);
    expect(r.stdout).toContain(
      '\n(dry run  - nothing written)\n\nAudit: would remove 2 junk memories (too short/empty).\n',
    );
    expect(s.rows()).toHaveLength(6);
    expect(s.audit()).toEqual(['__host__ cli consolidate']);
    expect(s.auditMeta()).toEqual([{ ...SLEPT, auditDeletedCount: 2, ambientTotal: 0, dryRun: true }]);
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    expect(await s.run('sleep', '--no-learn', '--no-share')).toEqual({ status: 1, stdout: '', stderr: NO_STORE });
    expect(s.storeMade()).toBe(false);
  });
});

describe('hippo refine (verb function, injected fetcher, no model)', () => {
  const MERGED = '[Consolidated from 2 related memories]\n\n';
  const answering =
    (text: string, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify({ content: [{ text }] }), { status });
  const refine = (s: Store, fetcher: typeof fetch, opts: Omit<RefineOptions, 'llm' | 'tenantId'> = {}) =>
    s.call(() =>
      refineStore(s.root, { llm: anthropicLlm({ apiKey: 'no-key', fetcher }), tenantId: 'default', ...opts }),
    );

  /** A merged row, a merged row already refined, and a plain one; the seeded text of each, by id. */
  function seedForRefine(s: Store) {
    const seeded = [
      `${MERGED}the billing service retries a failed charge, three times in a row`,
      `${MERGED}the invoice worker sends a receipt after each charge`,
      CLEAN,
    ];
    const merged = s.seed(seeded[0]!, { layer: Layer.Semantic, tags: ['billing'] });
    const refined = s.seed(seeded[1]!, { layer: Layer.Semantic, tags: ['llm-refined', 'billing'] });
    s.seed(CLEAN, { layer: Layer.Semantic });
    s.settle();
    return { merged, refined, seeded };
  }

  it('rewrites a merged row and tags it, skips a refined one, and rewrites both under all', async () => {
    const s = new Store();
    const { merged, refined } = seedForRefine(s);
    const first = await refine(s, answering('Failed charges are retried three times.'));
    const all = await refine(s, answering('Each charge is retried, then a receipt is sent.'), { all: true });
    expect(first.result).toEqual({
      scanned: 2,
      refined: 1,
      skipped: 1,
      failed: 0,
      details: [
        { id: merged, status: 'refined' },
        { id: refined, status: 'skipped', reason: 'already refined' },
      ],
    });
    expect(all.result).toEqual({
      scanned: 1,
      refined: 1,
      skipped: 0,
      failed: 0,
      details: [{ id: refined, status: 'refined' }],
    });
    expect(s.rows().map((r) => [r['content'], r['tags']])).toEqual([
      ['Failed charges are retried three times.', ['billing', 'llm-refined']],
      ['Each charge is retried, then a receipt is sent.', ['llm-refined', 'billing']],
      [CLEAN, []],
    ]);
    expect(s.audit()).toEqual([`default cli remember ${merged}`, `default cli remember ${refined}`]);
  });

  it('a failed model call leaves the row as it was', async () => {
    const s = new Store();
    const { merged, refined, seeded } = seedForRefine(s);
    const r = await refine(s, answering('ignored', 500));
    expect(r.stderr).toContain('[hippo] warn: refine: API answered HTTP 500');
    expect(r.result).toEqual({
      scanned: 2,
      refined: 0,
      skipped: 1,
      failed: 1,
      details: [
        { id: merged, status: 'failed', reason: 'api error or empty response' },
        { id: refined, status: 'skipped', reason: 'already refined' },
      ],
    });
    expect(contents(s)).toEqual(seeded);
    expect(s.audit()).toEqual([]);
  });

  it('dryRun writes nothing', async () => {
    const s = new Store();
    const { merged, refined, seeded } = seedForRefine(s);
    const r = await refine(s, answering('Failed charges are retried three times.'), { dryRun: true });
    expect(r.result).toMatchObject({
      refined: 1,
      details: [
        { id: merged, status: 'refined', reason: 'dry-run (no write)' },
        { id: refined, status: 'skipped' },
      ],
    });
    expect(contents(s)).toEqual(seeded);
    expect(s.audit()).toEqual([]);
  });
});

describe('hippo decide --supersedes (built CLI, no server)', () => {
  const decisions = (s: Store): string[] =>
    query(s.root, 'SELECT id, memory_id, status, superseded_by FROM decisions ORDER BY id').map((d) =>
      [d['id'], d['memory_id'], d['status'], d['superseded_by']].filter((p) => p != null).join(' '),
    );
  const recorded = (n: number, memory: string, supersedes?: string): string =>
    `Decision recorded: #${n}\n  memory: ${memory}\n${supersedes ? `  supersedes memory: ${supersedes}\n` : ''}`;
  const WEAKENED_ONLY = '(no active decision row; memory weakened only)';
  const DECISION_TAGS = ['decision', ...PATH_TAGS];

  it('weakens the memory of an earlier decision, and again on a second supersede', async () => {
    const s = new Store({ spawned: true });
    const first = await s.run('decide', 'use postgres for the ledger', '--context', 'it handles the join load');
    const oldId = s.lastId();
    const second = await s.run('decide', 'use sqlite for the ledger', '--supersedes', oldId);
    const third = await s.run('decide', 'use duckdb for the ledger', '--supersedes', oldId);
    const [, sqlite, duckdb] = s.rows().map((r) => String(r['id']));
    expect(first).toEqual({ status: 0, stdout: recorded(1, oldId), stderr: '' });
    expect(second.stdout).toBe(recorded(2, sqlite!, `${oldId} (decision #1 superseded)`));
    expect(third.stdout).toBe(recorded(3, duckdb!, `${oldId} ${WEAKENED_ONLY}`));
    // Each supersede halves the old row's half-life and marks it stale.
    expect(s.rows()).toMatchObject([
      {
        content: 'use postgres for the ledger\n\nContext: it handles the join load',
        layer: 'semantic',
        source: 'decision',
        confidence: 'stale',
        half_life_days: 91,
        tags: [...DECISION_TAGS, 'superseded'],
      },
      { content: 'use sqlite for the ledger', confidence: 'verified', half_life_days: 365, tags: DECISION_TAGS },
      { content: 'use duckdb for the ledger', confidence: 'verified', half_life_days: 365, tags: DECISION_TAGS },
    ]);
    expect(decisions(s)).toEqual([`1 ${oldId} superseded 2`, `2 ${sqlite} active`, `3 ${duckdb} active`]);
    expect(s.audit()).toEqual([
      'default cli decision_create 1',
      `default cli remember ${oldId}`,
      'default cli decision_supersede 1',
      'default cli decision_create 2',
      `default cli remember ${sqlite}`,
      `default cli remember ${oldId}`,
      'default cli decision_create 3',
      `default cli remember ${duckdb}`,
      `default cli remember ${oldId}`,
    ]);
  });

  it('weakens a plain memory that no decision row names', async () => {
    const s = new Store();
    const oldId = s.seed(CLEAN, { tags: ['billing'] });
    s.settle();
    const r = await s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    const newId = s.lastId();
    expect(r).toEqual({ status: 0, stdout: recorded(1, newId, `${oldId} ${WEAKENED_ONLY}`), stderr: '' });
    expect(s.rows()).toMatchObject([
      { id: oldId, confidence: 'stale', half_life_days: 182, tags: ['billing', 'superseded'], source: 'cli' },
      { id: newId, layer: 'semantic', source: 'decision', confidence: 'verified', tags: DECISION_TAGS },
    ]);
    expect(decisions(s)).toEqual([`1 ${newId} active`]);
    expect(s.audit()).toEqual([
      'default cli decision_create 1',
      `default cli remember ${newId}`,
      `default cli remember ${oldId}`,
    ]);
  });

  it('an unknown memory id, and --supersedes with no id', async () => {
    const s = new Store();
    expect(await s.run('decide', 'use sqlite for the ledger', '--supersedes', 'mem_does_not_exist')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Memory mem_does_not_exist not found.\n',
    });
    expect(await s.run('decide', 'use sqlite for the ledger', '--supersedes')).toEqual({
      status: 1,
      stdout: '',
      stderr: '--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.\n',
    });
    expect([s.rows(), decisions(s), s.audit()]).toEqual([[], [], []]);
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
    const r = await s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    const newId = s.lastId();
    expect(r).toEqual({
      status: 0,
      stdout: recorded(1, newId, `${oldId} ${WEAKENED_ONLY}`),
      stderr: `  warning: decision recorded and superseded, but failed to weaken the prior memory ${oldId}: refused\n`,
    });
    expect(s.rows()[0]).toMatchObject({ id: oldId, confidence: 'verified', half_life_days: 365, tags: ['billing'] });
    expect(decisions(s)).toEqual([`1 ${newId} active`]);
    expect(s.audit()).toEqual(['default cli decision_create 1', `default cli remember ${newId}`]);
  });
});

describe('hippo projects (built CLI, no server)', () => {
  it('lists two project names, and previews a merge and a repair', async () => {
    const s = new Store({ spawned: true });
    s.seed(CLEAN);
    s.seed('the checkout page caches the cart total for sixty seconds', {}, { originProject: 'web' });
    s.settle();
    const store = '<tmp>/acme/billing/ledger/app/.hippo';
    expect(await s.run('projects')).toEqual({
      status: 0,
      stdout:
        `2 project names in ${store} (newest write first):\n\n` +
        'web  1 memory, 0 imported from agent notes, newest <date>\n' +
        'app  1 memory, 0 imported from agent notes, newest <date>\n',
      stderr: '',
    });
    const project = { live: 1, imported: 0, newest: '<ts>', copiesElsewhere: 0 };
    expect(JSON.parse((await s.run('projects', '--json')).stdout)).toEqual({
      store,
      projects: [
        { origin: 'web', ...project },
        { origin: 'app', ...project },
      ],
    });
    const merge = await s.run('projects', 'merge', 'web', 'app');
    expect(merge.stdout).toMatch(/^Dry run: would merge web into app:\n/);
    expect(merge.stdout).toContain('\n  1 memory re-tagged, plus 0 dormant and 0 compaction records\n');
    const repair = await s.run('projects', 'repair');
    expect(repair.stdout).toMatch(new RegExp(`^Dry run: would repair ${store.replaceAll('.', '\\.')}:\n`));
    for (const preview of [merge, repair]) {
      expect(preview.stdout).toMatch(/\nNothing written\. Add --apply to run it\.\n$/);
    }
    expect(await s.run('projects', 'rename')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Usage: hippo projects [list] [--json] | merge <from> <into> [--apply] | repair [--apply]  [--global]\n',
    });
    expect(s.rows().map((r) => r['origin_project'])).toEqual(['app', 'web']);
    expect(s.audit()).toEqual([]);
  });

  it('a folder with no store', async () => {
    const s = new Store({ init: false });
    expect(await s.run('projects')).toEqual({ status: 1, stdout: '', stderr: NO_STORE });
    expect(s.storeMade()).toBe(false);
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

  /** Each inject and reread ledger row of one store as `surface event items tokens`, all under SESSION. */
  function ledger(root: string): string[] {
    const sql =
      "SELECT session_id, surface, event, items, tokens FROM token_ledger WHERE event IN ('inject', 'reread') ORDER BY id";
    return query(root, sql).map((r) => {
      expect(r['session_id']).toBe(SESSION);
      return `${r['surface']} ${r['event']} ${r['items']} ${r['tokens']}`;
    });
  }

  /** Ends a session of three model calls, and answers the run, the worker's re-read log lines and both stores' ledgers. */
  async function endSession(s: Store): Promise<{ ran: Ran; rereadLog: string[]; local: string[]; global: string[] }> {
    const transcript = join(s.base, `${SESSION}.jsonl`);
    writeFileSync(transcript, `${[1, 2, 3].map(callLine).join('\n')}\n`);
    const log = join(s.base, 'session-end.log');
    const ran = await s.run(
      '__session-end-worker',
      '--log-file',
      log,
      '--transcript',
      transcript,
      '--session-id',
      SESSION,
    );
    const rereadLog = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.includes('re-read'))
          .map((line) => line.replace(/^\[hippo\] \S+ /, ''))
      : [];
    return { ran, rereadLog, local: ledger(s.root), global: ledger(s.home) };
  }

  const rereadLine = (tokens: number): string => `re-read ${tokens} tokens over 3 model calls for session ${SESSION}`;

  // The process pin for session end: two spawned runs over a project store and the global store.
  it('books the project store and the global store, and a second pass leaves the same rows', async () => {
    const s = new Store({ global: true, spawned: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    const first = await endSession(s);
    const second = await endSession(s);
    for (const { ran } of [first, second]) {
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain('[hippo] sleep complete\n');
      expect(ran.stdout).toContain('[hippo] capture complete\n');
    }
    expect(second).toMatchObject({
      rereadLog: [rereadLine(260)],
      local: ['hook inject 1 100', 'hook reread 2 200'],
      global: ['hook_recall inject 1 30', 'hook_recall reread 2 60'],
    });
    expect(s.audit()).toEqual(['__host__ cli consolidate', '__host__ cli consolidate']);
  }, 42_000);

  it('a store that refuses the rows is logged, and the other store is still counted', async () => {
    const s = new Store({ global: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    exec(
      s.root,
      "CREATE TRIGGER refuse_reread BEFORE INSERT ON token_ledger WHEN NEW.event = 'reread' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    expect(await endSession(s)).toMatchObject({
      ran: { status: 0 },
      rereadLog: ['re-read count failed: refused', rereadLine(60)],
      local: ['hook inject 1 100'],
      global: ['hook_recall inject 1 30', 'hook_recall reread 2 60'],
    });
  });

  it('a folder with no store, here or globally', async () => {
    const s = new Store({ init: false });
    expect(await endSession(s)).toEqual({
      ran: { status: 0, stdout: '', stderr: '' },
      rereadLog: [rereadLine(0)],
      local: [],
      global: [],
    });
    expect(s.storeMade()).toBe(false);
  });
});
