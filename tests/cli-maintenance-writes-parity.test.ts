// Pins what `hippo watch`, `audit --fix`, `sleep`, `refine`, `decide --supersedes`, `projects` and the session-end worker store, audit and
// print on a real store with no server, so moving their writes and store opens out of the CLI cannot change a row or a byte.
// Masked: the temp folder, memory ids, ISO timestamps, calendar dates, Node's SQLite notice, four time columns; strength is rounded.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { adminActor, reject } from '../src/api/index.js';
import { refineStore, type RefineOptions } from '../src/cli/refine-llm.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type CreateMemoryOptions, type MemoryEntry } from '../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { captureError } from '../src/learn/autolearn.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { recordTokenUse, type TokenSurface } from '../src/store/token-ledger.js';
import { ownStderr } from './_helpers/own-stderr.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { hippoRun } from './_helpers/spawn-hippo.js';

const CASE_MS = 180_000;
const SPAWN_MS = 60_000;
// Keys that pick a tenant, a scope, a session, a server, a clock or a home for the child, so the developer's shell cannot change a row.
const DROPPED_ENV = [
  'HIPPO_TENANT', 'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_API_KEY',
  'HIPPO_REQUIRE_SERVER', 'HIPPO_STRICT_OWNER', 'HIPPO_FAKE_NOW', 'HIPPO_LOG', 'XDG_DATA_HOME', 'HIPPO_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'PATH',
];
const VOLATILE_COLUMNS = ['created', 'last_retrieved', 'valid_from', 'updated_at'];
const STRENGTH_DECIMALS = 6;
// Counters and one-time repair marks a verb leaves in `meta`; the schema version and the like stay out, as they change with every migration.
const META_KEYS = ['total_remembered', 'total_forgotten', 'project_repair_auto', 'quality_repair_auto'];
const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const AUDIT_COLUMNS = 'tenant_id, actor, op, target_id, metadata_json';

const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Row = Record<string, string | number | null>;
type Refined = Awaited<ReturnType<typeof refineStore>>;
/** State a case names itself, beside the rows every case pins. */
type Extra = { decisions?: Row[]; rereadLog?: string[]; ledger?: { local: Row[]; global: Row[] } };

function query(root: string, sql: string, ...params: Array<string | number>): Row[] {
  // Opening a missing store would create it, and the cases on a folder with no store pin that none appears.
  if (!existsSync(join(root, 'hippo.db'))) return [];
  const db = openHippoDb(root);
  try {
    // SAFETY: node:sqlite answers each row as a plain column-keyed object.
    return db.prepare(sql).all(...params) as Row[];
  } finally {
    closeHippoDb(db);
  }
}

function exec(root: string, sql: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(sql);
  } finally {
    closeHippoDb(db);
  }
}

function childEnv(home: string, user: string): NodeJS.ProcessEnv {
  const dropped = new Set(DROPPED_ENV);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!dropped.has(key.toUpperCase())) env[key] = value;
  // The global npm folder holds the developer's own `hippo` and agent CLIs, which no case may start.
  const path = (process.env['PATH'] ?? '').split(delimiter).filter((dir) => !/[\\/]npm[\\/]?$/i.test(dir)).join(delimiter);
  return { ...env, PATH: path, HIPPO_HOME: home, HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData', 'Roaming'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
}

/** Every way a run spells the temp folder: as made and resolved (macOS reaches it through a symlink), with either slash, and JSON-escaped. */
function spellingsOf(base: string): string[] {
  const paths = [base, realpathSync(base), realpathSync.native(base)];
  const all = paths.flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** One temp project with its own global store and home; `run` and `call` append each exit code and output to the transcript. */
class Store {
  readonly base = mkdtempSync(join(tmpdir(), 'hippo-maint-parity-'));
  // Four fixed folder names fill the path tags, so no tag carries the random temp name.
  readonly cwd = join(this.base, 'acme', 'billing', 'ledger', 'app');
  readonly root = join(this.cwd, '.hippo');
  readonly home = join(this.base, 'home');
  readonly env: NodeJS.ProcessEnv;
  private readonly spellings = spellingsOf(this.base);
  private readonly ids = new Map<string, string>();
  private readonly transcript: string[] = [];
  private auditMark = 0;

  constructor(opts: { init?: boolean; global?: boolean } = {}) {
    bases.push(this.base);
    mkdirSync(this.cwd, { recursive: true });
    const user = join(this.base, 'user');
    mkdirSync(user);
    this.env = childEnv(this.home, user);
    if (opts.init !== false) initStore(this.root);
    if (opts.global) initStore(this.home);
    this.settle();
  }

  /** Rows a case seeds in process are setup: audit rows up to here stay out of the record. */
  settle(): void {
    this.auditMark = Number(query(this.root, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log')[0]?.['n'] ?? 0);
  }

  seed(content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): string {
    const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options }), ...fields };
    writeEntry(this.root, entry);
    return entry.id;
  }

  /** A row with a fixed id, age and strength, for `sleep`, which decays from `created` against the fixed clock. */
  seedAged(id: string, created: string, content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): void {
    this.seed(content, options, { id, created, last_retrieved: created, valid_from: created, strength: 1, ...fields });
  }

  run(...args: string[]): void {
    const r = hippoRun(args, { cwd: this.cwd, env: this.env, timeout: SPAWN_MS });
    expect(r.error, `spawn ${args.join(' ')}`).toBeUndefined();
    this.transcript.push(`$ hippo ${args.join(' ')} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${ownStderr(r.stderr)}`);
  }

  /** A verb function with no flag for its test seam (the refine fetcher), run in this process with its output captured. */
  async call(label: string, fn: () => Promise<Refined>): Promise<void> {
    let answer: Refined | undefined;
    const r = await runInProcess(async () => { answer = await fn(); });
    this.transcript.push(`$ ${label} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}--- result\n${JSON.stringify(answer, null, 1)}\n`);
  }

  /** The newest row's id. */
  lastId(): string {
    return String(query(this.root, 'SELECT id FROM memories ORDER BY rowid DESC LIMIT 1')[0]!['id']);
  }

  private mask(text: string): string {
    let out = text.replace(/\r\n/g, '\n');
    for (const spelled of this.spellings) out = out.replaceAll(spelled, '<tmp>');
    return out
      .replace(/<tmp>[^\s"'`]*/g, (path) => path.replace(/\\+/g, '/'))
      .replace(/\b(?:mem|sem)_[0-9a-f]{12}\b/g, (id) => {
        if (!this.ids.has(id)) this.ids.set(id, `id#${this.ids.size + 1}`);
        return this.ids.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
      .replace(/\b\d{4}-\d\d-\d\d\b/g, '<date>');
  }

  private memories(root: string): Row[] {
    return query(root, 'SELECT * FROM memories ORDER BY rowid').map((row) => {
      for (const column of VOLATILE_COLUMNS) delete row[column];
      // Strength decays from `created`, so the stored value carries the microseconds the write took.
      return { ...row, strength: Number(Number(row['strength']).toFixed(STRENGTH_DECIMALS)) };
    });
  }

  /** Four snapshots, so a change to the audit rows alone shows as that and nothing else; `extra` is state the case names itself. */
  expectPinned(extra: Extra = {}): void {
    expect(this.mask(this.transcript.join('\n'))).toMatchSnapshot('output');
    expect(this.mask(JSON.stringify({ local: this.memories(this.root), global: this.memories(this.home) }, null, 1))).toMatchSnapshot('memory rows');
    const audit = {
      local: query(this.root, `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE id > ? ORDER BY id`, this.auditMark),
      global: query(this.home, `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id`),
    };
    expect(this.mask(JSON.stringify(audit, null, 1))).toMatchSnapshot('audit rows');
    const other = {
      storeMade: existsSync(join(this.root, 'hippo.db')),
      meta: query(this.root, `SELECT key, value FROM meta WHERE key IN (${META_KEYS.map((key) => `'${key}'`).join(', ')}) ORDER BY key`),
      ...extra,
    };
    expect(this.mask(JSON.stringify(other, null, 1))).toMatchSnapshot('other state');
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

  it('stores a failed command, and a second failure of it beside the first', () => {
    const s = new Store();
    scripts(s);
    s.run('watch', 'node fail.js');
    s.run('watch', 'node fail.js');
    s.expectPinned();
  }, CASE_MS);

  it('a failure that matches a rejected value is not stored', () => {
    const s = new Store();
    scripts(s);
    const value = captureError(3, STDERR, 'node fail.js').content;
    reject({ hippoRoot: s.root, tenantId: 'default', actor: adminActor('cli') }, { value, reason: 'wrong' });
    s.settle();
    s.run('watch', 'node fail.js');
    s.expectPinned();
  }, CASE_MS);

  it('a command that succeeds stores nothing', () => {
    const s = new Store();
    scripts(s);
    s.run('watch', 'node ok.js');
    s.expectPinned();
  }, CASE_MS);

  it('a folder with no store', () => {
    const s = new Store({ init: false });
    scripts(s);
    s.run('watch', 'node fail.js');
    s.expectPinned();
  }, CASE_MS);

  it('no command', () => {
    const s = new Store();
    s.run('watch');
    s.expectPinned();
  }, CASE_MS);
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
  it('removes each error and leaves the warnings', () => {
    const s = new Store();
    seedForAudit(s, true);
    s.run('audit', '--fix');
    s.run('audit', '--fix');
    s.expectPinned();
  }, CASE_MS);

  it('--dry-run removes nothing, and neither does a run without --fix', () => {
    const s = new Store();
    seedForAudit(s, true);
    s.run('audit');
    s.run('audit', '--fix', '--dry-run');
    s.expectPinned();
  }, CASE_MS);

  it('no errors, only warnings', () => {
    const s = new Store();
    seedForAudit(s, false);
    s.run('audit', '--fix');
    s.expectPinned();
  }, CASE_MS);

  it('a store where every row passes', () => {
    const s = new Store();
    s.seed(CLEAN);
    s.settle();
    s.run('audit', '--fix');
    s.expectPinned();
  }, CASE_MS);

  it('a folder with no store', () => {
    const s = new Store({ init: false });
    s.run('audit', '--fix');
    s.expectPinned();
  }, CASE_MS);
});

/** Rows under two project names, two the sleep audit removes, one pinned and one warning, all older than the fixed clock. */
function seedForSleep(s: Store): void {
  s.env['HIPPO_FAKE_NOW'] = FAKE_NOW;
  s.seedAged('mem_sleep_app', '2026-01-20T00:00:00.000Z', 'deploy rollback needs the database migration reverted before the api restarts', { tags: ['deploy'] });
  s.seedAged('mem_sleep_web', '2026-01-21T00:00:00.000Z', 'the checkout page caches the cart total for sixty seconds', { tags: ['web'] }, { origin_project: 'web' });
  s.seedAged('mem_sleep_short', '2026-01-22T00:00:00.000Z', 'too small');
  s.seedAged('mem_sleep_noise', '2026-01-23T00:00:00.000Z', 'Merge branch feature/billing into main');
  s.seedAged('mem_sleep_pinned', '2026-01-24T00:00:00.000Z', 'pinned ok', { pinned: true });
  s.seedAged('mem_sleep_warn', '2026-01-25T00:00:00.000Z', 'to fix the retry loop');
  s.settle();
}

describe('hippo sleep (built CLI, no server)', () => {
  it('removes audit errors on a store with two project names, and a second sleep finds none', () => {
    const s = new Store();
    seedForSleep(s);
    s.run('sleep', '--no-learn', '--no-share');
    s.run('sleep', '--no-learn', '--no-share');
    s.expectPinned();
  }, CASE_MS);

  it('--dry-run counts the errors and removes nothing', () => {
    const s = new Store();
    seedForSleep(s);
    s.run('sleep', '--dry-run', '--no-learn', '--no-share');
    s.expectPinned();
  }, CASE_MS);

  it('a folder with no store', () => {
    const s = new Store({ init: false });
    s.run('sleep', '--no-learn', '--no-share');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo refine (verb function, injected fetcher, no model)', () => {
  const MERGED = '[Consolidated from 2 related memories]\n\n';
  const answering = (text: string, status = 200): typeof fetch => async () => new Response(JSON.stringify({ content: [{ text }] }), { status });
  const refine = (s: Store, opts: Omit<RefineOptions, 'apiKey' | 'tenantId'>): Promise<Refined> => refineStore(s.root, { apiKey: 'no-key', tenantId: 'default', ...opts });

  function seedForRefine(s: Store): void {
    s.seed(`${MERGED}the billing service retries a failed charge, three times in a row`, { layer: Layer.Semantic, tags: ['billing'] });
    s.seed(`${MERGED}the invoice worker sends a receipt after each charge`, { layer: Layer.Semantic, tags: ['llm-refined', 'billing'] });
    s.seed(CLEAN, { layer: Layer.Semantic });
    s.settle();
  }

  it('rewrites a merged row and tags it, skips a refined one, and rewrites both under all', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore', () => refine(s, { fetcher: answering('Failed charges are retried three times.') }));
    await s.call('refineStore all', () => refine(s, { fetcher: answering('Each charge is retried, then a receipt is sent.'), all: true }));
    s.expectPinned();
  }, CASE_MS);

  it('a failed model call leaves the row as it was', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore', () => refine(s, { fetcher: answering('ignored', 500) }));
    s.expectPinned();
  }, CASE_MS);

  it('dryRun writes nothing', async () => {
    const s = new Store();
    seedForRefine(s);
    await s.call('refineStore dryRun', () => refine(s, { fetcher: answering('Failed charges are retried three times.'), dryRun: true }));
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo decide --supersedes (built CLI, no server)', () => {
  const decisions = (s: Store): Row[] => query(s.root, 'SELECT id, memory_id, decision_text, context, status, superseded_by, superseded_at, closed_at FROM decisions ORDER BY id');

  it('weakens the memory of an earlier decision, and again on a second supersede', () => {
    const s = new Store();
    s.run('decide', 'use postgres for the ledger', '--context', 'it handles the join load');
    const oldId = s.lastId();
    s.run('decide', 'use sqlite for the ledger', '--supersedes', oldId);
    s.run('decide', 'use duckdb for the ledger', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  }, CASE_MS);

  it('weakens a plain memory that no decision row names', () => {
    const s = new Store();
    const oldId = s.seed(CLEAN, { tags: ['billing'] });
    s.settle();
    s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  }, CASE_MS);

  it('an unknown memory id, and --supersedes with no id', () => {
    const s = new Store();
    s.run('decide', 'use sqlite for the ledger', '--supersedes', 'mem_does_not_exist');
    s.run('decide', 'use sqlite for the ledger', '--supersedes');
    s.expectPinned({ decisions: decisions(s) });
  }, CASE_MS);

  it('a weaken the store refuses still records the decision, with a warning', () => {
    const s = new Store();
    const oldId = s.seed(CLEAN, { tags: ['billing'] });
    for (const event of ['INSERT', 'UPDATE']) {
      exec(s.root, `CREATE TRIGGER refuse_weaken_${event} BEFORE ${event} ON memories WHEN NEW.id = '${oldId}' AND NEW.confidence = 'stale' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    }
    s.settle();
    s.run('decide', 'the billing service retries a failed charge five times', '--supersedes', oldId);
    s.expectPinned({ decisions: decisions(s) });
  }, CASE_MS);
});

describe('hippo projects (built CLI, no server)', () => {
  it('lists two project names, and previews a merge and a repair', () => {
    const s = new Store();
    s.seed(CLEAN);
    s.seed('the checkout page caches the cart total for sixty seconds', {}, { origin_project: 'web' });
    s.settle();
    s.run('projects');
    s.run('projects', '--json');
    s.run('projects', 'merge', 'web', 'app');
    s.run('projects', 'repair');
    s.run('projects', 'rename');
    s.expectPinned();
  }, CASE_MS);

  it('a folder with no store', () => {
    const s = new Store({ init: false });
    s.run('projects');
    s.expectPinned();
  }, CASE_MS);
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
      recordTokenUse(db, { tenantId: 'default', sessionId: SESSION, surface, event: 'inject', items: 1, tokens, hash: 'h1', now: iso(NOON) });
    } finally {
      closeHippoDb(db);
    }
  }

  function callLine(n: number): string {
    const message = { id: `m${n}`, model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 2 } };
    return JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: iso(NOON + n * 10_000), message });
  }

  /** Ends a session of three model calls, and answers the ledger rows of both stores and the worker's re-read log lines. */
  function endSession(s: Store): Extra {
    const transcript = join(s.base, `${SESSION}.jsonl`);
    writeFileSync(transcript, `${[1, 2, 3].map(callLine).join('\n')}\n`);
    const log = join(s.base, 'session-end.log');
    s.run('__session-end-worker', '--log-file', log, '--transcript', transcript, '--session-id', SESSION);
    const ledger = (root: string): Row[] => query(root, "SELECT tenant_id, session_id, surface, event, items, tokens FROM token_ledger WHERE event IN ('inject', 'reread') ORDER BY id");
    const rereadLog = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('re-read')) : [];
    return { rereadLog, ledger: { local: ledger(s.root), global: ledger(s.home) } };
  }

  it('books the project store and the global store, and a second pass leaves the same rows', () => {
    const s = new Store({ global: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    endSession(s);
    s.expectPinned(endSession(s));
  }, CASE_MS);

  it('a store that refuses the rows is logged, and the other store is still counted', () => {
    const s = new Store({ global: true });
    book(s.root, 'hook', 100);
    book(s.home, 'hook_recall', 30);
    exec(s.root, "CREATE TRIGGER refuse_reread BEFORE INSERT ON token_ledger WHEN NEW.event = 'reread' BEGIN SELECT RAISE(ABORT, 'refused'); END");
    s.expectPinned(endSession(s));
  }, CASE_MS);

  it('a folder with no store, here or globally', () => {
    const s = new Store({ init: false });
    s.expectPinned(endSession(s));
  }, CASE_MS);
});
