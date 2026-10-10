// Pins what `hippo remember`, `hippo supersede` and `hippo trace record` store, audit and print on the built CLI with no server,
// so moving their writes behind the api layer cannot change a row or a byte.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reject, remember, adminActor } from '../src/api/index.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { hippoRun } from './_helpers/spawn-hippo.js';

const CASE_MS = 180_000;
const SPAWN_MS = 60_000;
// Keys that pick a tenant, a scope, a session or a server for the child, so the developer's shell cannot change a row.
const DROPPED_ENV = ['HIPPO_TENANT', 'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_SESSION_ID', 'HIPPO_API_KEY', 'HIPPO_REQUIRE_SERVER', 'HIPPO_STRICT_OWNER'];
const VOLATILE_COLUMNS = ['created', 'last_retrieved', 'valid_from', 'updated_at'];
const SALIENCE_ON: StoreConfig = { salience: { enabled: true } };
// Node's own notice about node:sqlite carries the child's pid and differs by Node version.
const NODE_WARNING = /^\(node:\d+\) ExperimentalWarning: .*\r?\n\(Use `node --trace-warnings \.\.\.` .*\r?\n/m;
const STRENGTH_DECIMALS = 6;

/** The part of `config.json` a case sets. */
interface StoreConfig {
  salience: { enabled: boolean };
}

const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

type Row = Record<string, string | number | null>;

function query(root: string, sql: string, ...params: number[]): Row[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: node:sqlite answers each row as a plain column-keyed object.
    return db.prepare(sql).all(...params) as Row[];
  } finally {
    closeHippoDb(db);
  }
}

/** One temp project with its own global store; `run` appends each command's exit code and output to the transcript. */
class Store {
  readonly base = mkdtempSync(join(tmpdir(), 'hippo-write-parity-'));
  // Four fixed folder names fill the path tags, so no tag carries the random temp name.
  readonly cwd = join(this.base, 'acme', 'billing', 'ledger', 'app');
  readonly root = join(this.cwd, '.hippo');
  readonly home = join(this.base, 'home');
  private readonly env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: this.home };
  private readonly ids = new Map<string, string>();
  private readonly transcript: string[] = [];
  private auditMark = 0;

  constructor(config?: StoreConfig) {
    bases.push(this.base);
    mkdirSync(this.cwd, { recursive: true });
    for (const key of DROPPED_ENV) delete this.env[key];
    const init = hippoRun(['init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: this.cwd, env: this.env, timeout: SPAWN_MS });
    expect(init.status, init.stderr).toBe(0);
    if (config) this.mergeConfig(config);
    this.settle();
  }

  private mergeConfig(config: StoreConfig): void {
    const file = join(this.root, 'config.json');
    const held: object = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...held, ...config }));
  }

  /** Rows a case seeds in process are setup: audit rows up to here stay out of the record. */
  settle(): void {
    this.auditMark = Number(query(this.root, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log')[0]!['n']);
  }

  run(...args: string[]): void {
    const r = hippoRun(args, { cwd: this.cwd, env: this.env, timeout: SPAWN_MS });
    expect(r.error, `spawn ${args.join(' ')}`).toBeUndefined();
    this.transcript.push(`$ hippo ${args.join(' ')} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr.replace(NODE_WARNING, '')}`);
  }

  /** The newest row's id, which a supersede names. */
  lastId(): string {
    return String(query(this.root, 'SELECT id FROM memories ORDER BY rowid DESC LIMIT 1')[0]!['id']);
  }

  private mask(text: string): string {
    return text
      .replaceAll(this.base, '<tmp>')
      .replace(/\b(?:mem|sem)_[0-9a-f]{12}\b/g, (id) => {
        if (!this.ids.has(id)) this.ids.set(id, `id#${this.ids.size + 1}`);
        return this.ids.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  }

  private memories(root: string): Row[] {
    if (!existsSync(root)) return [];
    return query(root, 'SELECT * FROM memories ORDER BY rowid').map((row) => {
      for (const column of VOLATILE_COLUMNS) delete row[column];
      // Strength decays from `created`, so the stored value carries the microseconds the write took.
      return { ...row, strength: Number(Number(row['strength']).toFixed(STRENGTH_DECIMALS)) };
    });
  }

  /** Three snapshots, so a change to the audit rows alone shows as that and nothing else. */
  expectPinned(): void {
    expect(this.mask(this.transcript.join('\n'))).toMatchSnapshot('output');
    expect(this.mask(JSON.stringify({ local: this.memories(this.root), global: this.memories(this.home) }, null, 1))).toMatchSnapshot('memory rows');
    const audit = query(this.root, 'SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE id > ? ORDER BY id', this.auditMark);
    const globalAudit = existsSync(this.home) ? query(this.home, 'SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY id') : [];
    expect(this.mask(JSON.stringify({ local: audit, global: globalAudit }, null, 1))).toMatchSnapshot('audit rows');
  }
}

const REMEMBER_FLAGS: ReadonlyArray<[string, string[]]> = [
  ['plain', []],
  ['--tag twice', ['--tag', 'billing', '--tag', 'retry']],
  ['--error', ['--error']],
  ['--pin', ['--pin']],
  ['--observed', ['--observed']],
  ['--inferred', ['--inferred']],
  ['--scope', ['--scope', 'team:eng']],
  ['--owner', ['--owner', 'user:alice']],
  ['--artifact-ref', ['--artifact-ref', 'gh://acme/billing/pull/12']],
  ['--kind superseded', ['--kind', 'superseded']],
  ['--global', ['--global']],
  ['every row flag at once', ['--tag', 'billing', '--error', '--pin', '--inferred', '--scope', 'team:eng', '--owner', 'user:alice', '--artifact-ref', 'gh://acme/billing/pull/12', '--kind', 'superseded']],
];

describe('hippo remember (built CLI, no server)', () => {
  it.each(REMEMBER_FLAGS)('%s', (_label, flags) => {
    const s = new Store();
    s.run('remember', 'the billing service retries a failed charge three times', ...flags);
    s.expectPinned();
  }, CASE_MS);

  it('a second row whose tags the store already holds', () => {
    const s = new Store();
    s.run('remember', 'the billing service retries a failed charge three times', '--tag', 'billing');
    s.run('remember', 'the invoice worker sends a receipt after each charge', '--tag', 'billing');
    s.expectPinned();
  }, CASE_MS);

  it('the salience gate skips a repeat of the same text, and --force stores it', () => {
    const s = new Store(SALIENCE_ON);
    s.run('remember', 'the billing service retries a failed charge three times');
    s.run('remember', 'the billing service retries a failed charge three times');
    s.run('remember', 'the billing service retries a failed charge three times', '--force');
    s.expectPinned();
  }, CASE_MS);

  it('the salience gate weakens a repeated error', () => {
    const s = new Store(SALIENCE_ON);
    for (let n = 1; n <= 4; n++) {
      writeEntry(s.root, createMemory(`connection timeout on database shard ${n}`, { tags: ['error'], baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    }
    s.settle();
    s.run('remember', 'connection timeout on database shard 5', '--error');
    s.expectPinned();
  }, CASE_MS);

  it('a rejected value is refused', async () => {
    const s = new Store();
    await reject({ hippoRoot: s.root, tenantId: 'default', actor: adminActor('cli') }, { value: 'the billing service retries a failed charge nine times', reason: 'wrong' });
    s.settle();
    s.run('remember', 'the billing service retries a failed charge nine times');
    s.expectPinned();
  }, CASE_MS);
});

const SUPERSEDE_FLAGS: ReadonlyArray<[string, string[], string[]]> = [
  ['plain', [], []],
  ['--layer', [], ['--layer', 'semantic']],
  ['--tag', ['--tag', 'billing'], ['--tag', 'paging']],
  ['--pin', [], ['--pin']],
  ['a pinned old row', ['--pin', '--tag', 'billing'], []],
  ['every flag at once on a tagged, scoped old row', ['--tag', 'billing', '--scope', 'team:eng', '--observed'], ['--layer', 'semantic', '--tag', 'paging', '--tag', 'oncall', '--pin']],
];

describe('hippo supersede (built CLI, no server)', () => {
  it.each(SUPERSEDE_FLAGS)('%s', (_label, oldFlags, flags) => {
    const s = new Store();
    s.run('remember', 'the billing service retries a failed charge three times', ...oldFlags);
    s.run('supersede', s.lastId(), 'the billing service retries a failed charge five times', ...flags);
    s.expectPinned();
  }, CASE_MS);

  it('a missing id', () => {
    const s = new Store();
    s.run('supersede', 'mem_does_not_exist', 'the billing service retries a failed charge five times');
    s.expectPinned();
  }, CASE_MS);

  it('an id that is already superseded', () => {
    const s = new Store();
    s.run('remember', 'the billing service retries a failed charge three times');
    const oldId = s.lastId();
    s.run('supersede', oldId, 'the billing service retries a failed charge five times');
    s.run('supersede', oldId, 'the billing service retries a failed charge seven times');
    s.expectPinned();
  }, CASE_MS);

  it('new content that is a rejected value', async () => {
    const s = new Store();
    await reject({ hippoRoot: s.root, tenantId: 'default', actor: adminActor('cli') }, { value: 'the billing service retries a failed charge nine times', reason: 'wrong' });
    s.settle();
    s.run('remember', 'the billing service retries a failed charge three times');
    s.run('supersede', s.lastId(), 'the billing service retries a failed charge nine times');
    s.expectPinned();
  }, CASE_MS);

  it("another person's personal row", () => {
    const s = new Store();
    const owner = { subject: 'api_key:hk_a', role: 'member', owner: 'a' } as const;
    const { id } = remember({ hippoRoot: s.root, tenantId: 'default', actor: owner }, { content: 'my own note about the billing retry count', personal: true });
    s.settle();
    s.run('supersede', id, 'a newer note about the billing retry count');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo trace record (built CLI, no server)', () => {
  const steps = JSON.stringify([{ action: 'ran the migration', observation: 'two tables changed' }, { action: 'ran the tests', observation: 'all passed' }]);

  it('the required flags alone', () => {
    const s = new Store();
    s.run('trace', 'record', '--task', 'migrate the billing tables', '--steps', steps, '--outcome', 'success');
    s.expectPinned();
  }, CASE_MS);

  it('--session, --tag and --source', () => {
    const s = new Store();
    s.run('trace', 'record', '--task', 'migrate the billing tables', '--steps', steps, '--outcome', 'partial', '--session', 'sess-1', '--tag', 'deploy', '--source', 'agent');
    s.expectPinned();
  }, CASE_MS);

  it('an outcome outside the three', () => {
    const s = new Store();
    s.run('trace', 'record', '--task', 'migrate the billing tables', '--steps', steps, '--outcome', 'unknown');
    s.expectPinned();
  }, CASE_MS);
});
